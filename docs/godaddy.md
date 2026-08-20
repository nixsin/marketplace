# GoDaddy — domain registration

GoDaddy's only remaining role in this project is **registrar**: it owns
the `laxair.shop` registration and delegates DNS elsewhere. Nothing
about the running site touches GoDaddy.

Related: [cloudflare.md](./cloudflare.md) (where DNS is actually served)
and [render.md](./render.md) (where the domain points).

---

## 1. What we use it for

| Job | Status |
|---|---|
| Domain registration and renewal for `laxair.shop` | **Active** |
| DNS hosting | **No** — delegated to Cloudflare |
| Email, hosting, SSL, parking | **No** — none purchased |

This separation is deliberate. Keeping registration and DNS apart means
a DNS change never risks the registration, and moving DNS providers is
a nameserver edit rather than a domain transfer.

---

## 2. Setup — nameserver delegation

GoDaddy → **My Products → Domains → `laxair.shop` → Nameservers →
Change → I'll use my own nameservers**, then enter the two Cloudflare
nameservers assigned to the zone (see
[cloudflare.md §2.1](./cloudflare.md#21-delegation)).

Verify from a shell rather than the dashboard, which caches:

```bash
dig +short NS laxair.shop
```

Should return the two `*.ns.cloudflare.com` names. Propagation is
typically minutes, occasionally up to 24 hours.

**Once delegated, GoDaddy's DNS panel is inert.** Records edited there
have no effect — a real source of confusion later. All record changes
happen in Cloudflare.

---

## 3. What was left behind

Cloudflare imported GoDaddy's existing records at onboarding, including
ones that actively broke the site. They are listed and explained in
[cloudflare.md §2.2](./cloudflare.md#22-dns-records) — the parking A
records (`13.248.243.5`, `76.223.105.230`) and the `pay` /
`_domainconnect` service records.

Worth knowing for any future domain: a registrar's default records
follow you into the new DNS provider and are not automatically correct.

---

## 4. Keys and secrets

**None.** No GoDaddy API credentials are used by this project, and none
are needed — nothing automated touches the registrar.

The GoDaddy account login itself is the only credential, and it is not
stored anywhere in this repository.

---

## 5. Caching

**Not applicable.** GoDaddy serves nothing for this project. The one
caching-adjacent concept at registrar level is DNS TTL, and that is
controlled in Cloudflare (currently `Auto`).

---

## 6. Subscription, cost, and limits

| Item | Detail |
|---|---|
| Product | `.shop` domain registration |
| Term | Annual |
| **Auto-renew** | **Verify this is ON** — see below |
| Other GoDaddy products | None |

**The one thing that matters here: renewal.** A lapsed domain takes the
site down completely, and `.shop` can enter a redemption period with a
significant recovery fee. Two things worth confirming in the account:

1. **Auto-renew enabled** on the domain.
2. **A valid payment method** on file, and an email address that is
   monitored — renewal failure notices go there.

Registration price is set by GoDaddy and varies by TLD and promotional
period; check the account for the current renewal amount, as first-year
promotional pricing on `.shop` is commonly much lower than renewal.

**Also check:** GoDaddy enables **Domain Privacy** by default on many
TLDs, sometimes as a paid add-on. Confirm whether it is included or
billed separately.

---

## 7. Migrating away from GoDaddy

Two very different operations — do not confuse them.

### 7.1 Moving DNS (already done)

Covered in §2. Does not involve GoDaddy beyond the nameserver field.
Reversible in minutes.

### 7.2 Transferring the registration

Moving the domain to another registrar (Cloudflare Registrar, Namecheap,
Porkbun). Steps:

1. **Unlock** the domain in GoDaddy.
2. **Disable domain privacy** temporarily if it blocks the auth code.
3. Request the **EPP / authorization code**.
4. Start the transfer at the new registrar and pay — a transfer usually
   includes one year of renewal.
5. **Approve** the transfer from the email on the registration.

**Constraints worth knowing before planning this:**

- ICANN forbids transfer within **60 days of registration** or of a
  previous transfer.
- A change of registrant contact can also trigger a 60-day lock.
- Transfer takes up to **5 days** to complete.
- **DNS is unaffected** if nameservers already point at Cloudflare — the
  site keeps serving throughout, which is the main practical benefit of
  the split in §1.

**If moving to Cloudflare Registrar specifically:** it sells at
wholesale cost with no markup and includes privacy, but requires the
zone to already use Cloudflare DNS (it does). It does not support every
TLD — confirm `.shop` is supported before planning.

---

## 8. Known state and open items

- **Confirm auto-renew and payment method** — §6. This is the single
  highest-consequence unchecked item for this provider: everything else
  in the infrastructure is recoverable, a lost domain is not.
- Registration remains at GoDaddy; no transfer planned.
