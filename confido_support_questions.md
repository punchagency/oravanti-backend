# Questions for Confido Legal support

Compiled from building the integration (firm onboarding + taking payments) against the sandbox.
Grouped by what they block. Everything here is something we could not answer from the docs or by
experiment.

**Context:** we are a partner integration (legal intake platform). Our firms will be onboarded
through `onboarding.js`, take payments through hosted Payment Links embedded in an iframe on our
domain, and we record each transaction into our own trust/operating ledger. We are deploying on
your **updated platform** — that is confirmed, and the questions below assume it.

---

## Blocking — we cannot build these without an answer

### 1. Connect (OAuth) — the whole flow except the last step

We can see `firmApiTokenExchangeCode(input: { code, nickname })` in the schema, and the docs
describe Connect at a high level, but nothing documents how a partner actually gets a `code`.

- **What is the authorize URL**, and what query parameters does it take?
- **Is the `state` parameter round-tripped back to our callback verbatim?**
- **Do redirect/callback URIs have to be registered** with you in advance, and if so where?

We have deliberately not shipped Connect because of the second question. Without `state` binding the
exchange to the session that started it, an attacker-supplied `code` could bind their merchant
account to another firm's organization — meaning that firm's client payments would settle into the
attacker's bank account. We are not willing to ship that on an assumption.

### 2. Sponsor bank configuration — where does a refund debit from?

Your article *"Issued a refund to a client from my trust account…"* describes two configurations:
legacy (refund debits **operating**, firm must then transfer trust→operating manually) and the new
sponsor bank (refund debits **trust** directly). It ends by saying to contact you to find out which
applies, and nothing in the API exposes it.

- **Which sponsor bank configuration will our firms be on?** Is it partner-wide or per firm?
- **Is "updated platform" the same thing as "new sponsor bank configuration",** or are they
  independent? They are described in separate articles and we cannot tell.

We have confirmation that our firms are on the **newer platform** (see question 4), but that was
about surcharge deposits and does not tell us which account a refund debits. If the two are the same
thing, saying so answers this outright.

This decides our entire refund model. On the new configuration a trust refund moves trust money and
our ledger matches the bank. On legacy it does not, and we would have to model a manual transfer the
firm may never make — which would leave the trust ledger disagreeing with the trust bank account,
the one reconciliation that must never drift.

### 3. Trusted Domains — does it cover iframes and onboarding.js?

Trusted Domains is documented under Hosted Fields. We use two other embeds: `onboarding.js` and a
Payment Link in an iframe.

- **Does registering a domain under Settings → Trusted Domains also permit `onboarding.js` to load
  there, and permit a Payment Link to be framed there?**

We ask because the hosted payment page currently returns
`content-security-policy-report-only: … frame-ancestors https://*.confidolegal.com …` — our domain
is not in that list, and the policy is report-only. If it is ever enforced without our domain being
added, every embedded payment breaks at once. **Sandbox does not enforce domain restrictions at
all**, so nothing we can test will catch this before production.

---

## Important — we have shipped a defensive workaround, but would rather not guess

### 4. Surcharging on the updated platform — ANSWERED, with one follow-up

> "Yes, your firms will all be on the newer platform, so **no surcharge will be deposited**. You can
> still initiate refunds on them and firms can still see the surcharge amounts in their reporting."
> — Emery Wager, 18 Aug 2026

So on the updated platform there is no separate surcharge transaction crediting the operating
account, which removes the risk of booking one as invoice revenue.

One thing still worth confirming, because "firms can still see the surcharge amounts in their
reporting" implies the number exists somewhere:

- **Does a surcharged payment still return a non-zero `Transaction.surchargeAmount`**, even though
  nothing extra is deposited? And is `amountProcessed` still exclusive of it?
- **What is `Transaction.legacySurchargeAmount` for**, versus `surchargeAmount`?

We record `amountProcessed` per transaction as the amount credited to the invoice, so we need to be
sure the surcharge is reported alongside it rather than folded into it.

### 5. Fee debits against insufficient funds

Fees are debited monthly from the account carrying `isFeeAccount`. We now set that explicitly to the
firm's operating account.

- **What happens when that debit fails for insufficient funds?** Retry cadence?
- **Can a failed fee debit ever fall back to another account — specifically the trust account?**
- **Does repeated failure move the firm to `SUSPENDED`?**

We need an explicit "no" on the trust question. A processing fee reaching an IOLTA account is a bar
complaint, not an accounting problem.

### 6. `FirmStatus.SUSPENDED`

`SUSPENDED` is in the `FirmStatus` enum but appears in no documentation.

- **What puts a firm into `SUSPENDED`, and how does it leave?** Is it recoverable by the firm, or
  does it require you?

We handle it in our state machine, but the message we show a firm is currently a guess.

---

## Confirmations — we believe we have these right, but they are load-bearing

### 7. Statement amounts are in cents

`StatementDebit.amount` and every `StatementBankAccount` fee field are typed `Float!`, while
`StatementAdditionalCredit.amount` is typed `Int!` — in the same object.

- **Are all statement amounts in cents, including the `Float!` ones?**

We concluded yes: `cardFees + achFees == totalFees` holds exactly, and a mock "unauthorized ACH
return" fee arrived as `2500`, which reads as $25 rather than $2,500. Confirming, because getting it
wrong is a 100× error on money.

### 8. `externalId` uniqueness

We use `externalId` as our idempotency key — our invoice id on a Payment Link, and our client/lead id
on a Client — and look records up by it before creating.

- **Is `externalId` enforced unique per firm?** What happens if two Payment Links are created with
  the same one — does `paymentLink(externalId:)` then error, or return an arbitrary one?

This matters because `addPaymentLink` has no idempotency key and there is no delete endpoint, so a
duplicate is permanent.

### 9. `paymentLink(externalId:)` reports "not found" as a 500

A missing Client returns `400 USER_INPUT_ERROR`. A missing Payment Link returns **`500
INTERNAL_SERVER_ERROR`** with the message `"Paylink not found"`.

- **Is that intentional?** We have to match on the message text to distinguish "does not exist" from
  "the API is down" — and treating an outage as absence would make us mint duplicate links. A 404 or
  a `USER_INPUT_ERROR` would let us classify it properly.

### 10. Transient "Access denied" on `statements`

Querying `statements` returned `Access denied! You don't have permission for this action!` twice in a
row with both a firm token and a partner token, then worked seconds later with the same firm token
and no changes.

- **Is there a rate limit or propagation delay that surfaces as an authorization error?** We would
  like to know whether to treat it as retryable.

---

## Minor

### 11. ACH deposit timeline for firms onboarded now

Your article says firms onboarded after September 2025 receive ACH deposits on a +2 business day
timeline rather than same-day.

- **Does that apply to firms we onboard now?** It affects what we tell a firm about when money
  arrives, and when we consider a payment settled.

### 12. `firmUpdate` has no `firmId`

`FirmUpdateInput` takes only `defaultOperatingId`, `defaultTrustId` and `feeBankAccountId` — no
`firmId`, unlike `paymentSettingsUpdate` and `firmBrandingUpdate` which both take one.

- **Confirming this is intentional** and the mutation is scoped by the firm token. We call it with a
  firm token and it works; just checking we are not relying on an accident.
