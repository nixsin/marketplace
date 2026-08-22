# WhatsApp inquiry delivery

How a buyer's inquiry reaches a seller, and the parts of it that live in a
Meta account rather than in this repository.

## Business-initiated messages require an approved template

This is the single most important fact here, and the first implementation got
it wrong: it sent `type: "text"` and would have failed **every production
send** while passing every test.

WhatsApp only permits free-form text inside a **24-hour customer-service
window**, which the *recipient* opens by messaging the business first. This
flow is always business-initiated — the marketplace speaks first, to a seller
who has never messaged it — so there is no window, and Meta rejects free-form
text with valid credentials and a valid number.

So `WhatsappService.sendInquiry` sends a template whenever
`WHATSAPP_TEMPLATE_NAME` is set. The text path remains only for development
and for the case where a reply window genuinely exists.

## The template contract

The approved template must have a **body with exactly two placeholders**:

```
Body:  New inquiry from the marketplace.
       {{1}}

       {{2}}
```

- `{{1}}` — product and contact summary
- `{{2}}` — the buyer's own message

**Two, not one, and the reason matters.** A single combined parameter meant a
near-limit question lost its ending to the product metadata in front of it —
silently, after the API had already accepted the message as valid. Separate
parameters give the buyer's words their own budget.

**Parameters are flattened before sending.** Meta rejects a parameter
containing a newline, a tab, or more than four consecutive spaces — and
rejects the *whole message*, not just the parameter. The composed inquiry is
deliberately multi-line, so `sanitizeTemplateParam` replaces newlines with
` · `, collapses whitespace runs, and truncates. Without it every send fails
validation.

## Environment variables

Values live in the deployment environment; only the **names** are in this
repository (`packages/config`), matching the `resolveApiKey` precedent — a
committed value would enter git history permanently.

| Variable | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta access token |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's id |
| `WHATSAPP_TEMPLATE_NAME` | Approved template. **Required** — unset means sends are refused, not attempted |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Template language code, default `en` |

| `WHATSAPP_ALLOW_FREE_FORM` | Opt-in for free-form text. **Only for a known open service window**, never as a fallback |

**The template name is required configuration, not optional.** An earlier
version fell back to free-form text whenever it was merely absent — so a
deployment with valid credentials but no template would send a request Meta
is known to reject for this flow and mark *every* inquiry `FAILED`, leaving
an operator debugging provider errors for what is a missing environment
variable. Sends are now refused before the request, with the missing variable
named.

With the credentials absent the service logs a warning naming only the
variables and returns a failure — the inquiry is still recorded, because
losing a real lead to a configuration gap is the worse outcome.

## Abuse control

The mutation is unauthenticated by design (#91 story 3: a WhatsApp-shared link
must work on a cold visit), which makes it an outbound-message relay unless it
is bounded. Four limits, because they fail differently:

| Limit | Keyed on | Defeated by |
|---|---|---|
| per phone | submitted `buyerPhone` | rotating numbers |
| per phone + product | submitted fields | rotating numbers |
| per IP | **skipped unless BOTH `INQUIRY_TRUST_PROXY_HEADERS=true` and a ≥16-char `INQUIRY_IP_HASH_SECRET` are set** | proxies, at a cost |
| **per seller** | the seller | nothing available to a caller |

**Proxy headers are not trusted by default.** `cf-connecting-ip` is only
believable when every route to the origin passes through Cloudflare — and this
origin answers directly on its `.onrender.com` hostname, so a caller who skips
the edge could set a fresh value per request. Set
`INQUIRY_TRUST_PROXY_HEADERS=true` **only after** the origin refuses
non-proxied traffic.

**Until then the per-IP limit does not run at all**, and that is deliberate.
An earlier version fell back to the socket address, but Render fronts every
service with a load balancer, so that address is the *balancer* — identical
for every buyer. All callers shared one hash, and after
`INQUIRY_RATE_LIMIT_PER_IP` inquiries the limit rejected everyone, for every
seller, for the rest of the window: a global outage of the feature, created
while closing a spoofing hole. With no trustworthy per-client address the
honest answer is none, so the bucket is skipped and the per-seller cap is
what bounds exposure by default.

Note this also means `req.ip` is deliberately **not** consulted while the flag
is off: Express derives it from `X-Forwarded-For` whenever app-level
`trust proxy` is enabled, which would let a spoofable value back in through a
setting invisible from the inquiry code.

**The two phone limits are keyed on a value the caller types**, so on their own
they are decorative — that was a real review finding, not a hypothetical. They
stay because they give a genuine buyer sane feedback.

The per-seller cap is the one that still holds when a caller rotates both
numbers and addresses, so it is what actually bounds how much spam a seller can
be made to receive. Its rejection message is deliberately vague: naming it
would hand an attacker a progress indicator for the one limit they cannot
rotate around.

None of this replaces CAPTCHA or verified phone numbers. It is defence in
depth in front of them.

**The check and the insert run in one `Serializable` transaction.** Counting
and then inserting separately is a time-of-check/time-of-use race in which
concurrent callers all read a count below the threshold and all proceed.

**IPs are stored HMAC-hashed, or not at all.** A raw address is personal data
under DPDP sitting in a table operators read to triage leads. Without a
sufficiently long `INQUIRY_IP_HASH_SECRET` nothing is stored and the per-IP
limit simply does not run — an *unkeyed* SHA-256 is reversible by anyone
holding the table, since IPv4's 2^32 space is enumerable outright, so a
digest labelled "unkeyed" advertised the weakness without removing it. An unresolvable address is skipped rather than counted
as a shared `null` bucket — otherwise one such caller could lock out all the
others.

## `delivered` means accepted, not received

`InquiryStatus.SENT` and the `delivered` flag both mean **the provider
accepted the message** — nothing more. Meta can accept a send and still fail
to deliver it: an invalid number, a blocked contact, a number no longer on
WhatsApp.

The UI copy is worded to match ("on its way to this seller", never "this
seller has your question"). An earlier version claimed receipt, which the
schema's own comment on `SENT` had always contradicted.

**Real delivery confirmation requires Meta's delivery webhook**, which is not
wired up. `providerMessageId` is stored precisely so a webhook can correlate
back to the row when it is.

## Idempotency

**Submission is idempotent.** The client generates one key per submission and
reuses it on every retry; `Inquiry.idempotencyKey` carries a unique index, so
a replay returns the original row rather than creating a second inquiry and
sending the seller a second message.

A lost response is indistinguishable from a failed one, so retries are
expected rather than exceptional — which is why the constraint lives in the
database and not in a client that has to remember.

**Ambiguous provider outcomes stay `PENDING`.** A timeout or dropped
connection means Meta may already have accepted the message, so recording it
`FAILED` invites a retry that double-messages the seller. `PENDING` says what
is actually true: we do not know. Only a definite provider rejection becomes
`FAILED`.

This was originally deferred as a launch prerequisite, on the grounds that the
send is a no-op without credentials. That reasoning was too weak — enabling
the hazard takes one environment variable and no code change.

## Still required before going live## Still required before going live

- Meta Business account, a verified sending number, and an **approved
  template** matching the contract above.
- DPDP and CDSCO review (#91). Neither has been checked against current law.
