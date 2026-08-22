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

The approved template must have a **body with exactly one `{{1}}`
placeholder**. The whole composed inquiry is passed as that single parameter.

More parameters would mean more ways for this repository and a Meta account
nobody here can read to disagree about a template's shape — a disagreement
that surfaces only as rejected sends in production.

```
Body:  New inquiry from the marketplace: {{1}}
```

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
| `WHATSAPP_TEMPLATE_NAME` | Approved template. **Unset ⇒ free-form text, which production rejects** |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Template language code, default `en` |

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
| per IP | `cf-connecting-ip` | proxies, at a cost |
| **per seller** | the seller | nothing available to a caller |

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

## Still required before going live

- Meta Business account, a verified sending number, and an **approved
  template** matching the contract above.
- DPDP and CDSCO review (#91). Neither has been checked against current law.
