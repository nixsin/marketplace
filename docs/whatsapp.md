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
| per IP | **skipped entirely unless `INQUIRY_TRUST_PROXY_HEADERS=true`**, then `cf-connecting-ip` | proxies, at a cost |
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

**IPs are stored hashed.** A raw address is personal data under DPDP sitting in
a table operators read to triage leads; a hash still counts repeats, which is
all the limiter needs. An unresolvable address is skipped rather than counted
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

## Idempotency — required before going live, not before merging

**Submission is not idempotent.** If a response is lost, `submitInquiry`
reports a network failure even though the API may already have persisted and
sent the inquiry; a retry then creates a second inquiry and a second WhatsApp
message. `sendInquiry` has the same shape: a timeout is classified as a
definite failure even though Meta may have accepted the request before the
response was lost.

The fix is a stable per-submission idempotency key with a database uniqueness
constraint, plus treating ambiguous provider outcomes as `PENDING` rather than
retryable `FAILED`.

**It is deliberately not in the initial PR**, for one reason that can be
checked rather than argued: **the send is a logged no-op until the Meta
credentials exist**, so no duplicate message can reach a seller today. That
makes this a launch prerequisite alongside the account setup below, not a
merge blocker — and it is a schema change plus a real design decision about
ambiguous outcomes, which is better done deliberately than bolted onto a
review round.

## Verify at configuration time

Two review findings were merged over deliberately because neither can be
settled from this repository, and both become testable the moment a Meta
account exists. **Check them with the first real send, before any traffic.**

- **Recipient format.** We send `to: "+919876543210"`. A review argued the
  Cloud API expects country-code digits **without** the `+`. If that is right,
  every send fails; the fix is `toE164.slice(1)`, keeping the plus form for
  storage and validation. Settle it against the real API, not from memory.
- **Provider error text is logged before truncation.** A multiline or very
  long provider response could forge log lines or bloat entries. The database
  write already truncates to 500; the log call does not.

## Still required before going live

- Meta Business account, a verified sending number, and an **approved
  template** matching the contract above.
- **Idempotency keys** (above). Without them the first real provider timeout
  can double-message a seller.
- DPDP and CDSCO review (#91). Neither has been checked against current law.
