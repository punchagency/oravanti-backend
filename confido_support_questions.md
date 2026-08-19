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

_(Question 2 below is now resolved; kept in place so the numbering matches earlier correspondence.)_

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

### 2. Sponsor bank configuration — RESOLVED (decision), one thing to action

**Decided: our firms are on the new sponsor bank configuration**, following from Confido's
confirmation that they are all on the newer platform. Refunds therefore debit the **trust account
directly**, and a trust refund moves trust money rather than requiring a manual transfer.

Recorded as a decision rather than a quotation: Confido confirmed the _platform_ in the context of
surcharge deposits, and describes the sponsor-bank configuration in a separate article. If they ever
diverge for us, slice 3's refund model is what changes.

**The one thing this makes actionable**, and it fails silently until the first refund:

- Each firm's bank must permit Confido's originator IDs to debit their **trust** account:

  ```
  2638633811   9263863381   8263863381
  4263863381   3263863381   2263863380
  ```

  > "If these IDs are not allowed by your bank, the refund may be blocked."

- **Is that list current and complete?** Worth confirming, since a firm has to take it to their bank
  during onboarding and a stale ID means a blocked refund months later.

### 3. Trusted Domains — REPRODUCED, and it is blocking us today

We previously filed this as a risk for production. It is not a risk; it is happening now in sandbox,
and the earlier note that "sandbox does not enforce domain restrictions at all" was wrong.

Embedding a Payment Link in an iframe on our origin gives a page that **renders but cannot be
used**: the layout, the amount, the Pay button and your branding all appear, while the card number,
expiry and CVV fields stay greyed with a spinner and cannot be focused.

The console shows why. The outer page's policy is report-only and passes:

```
Framing 'https://pay.sandbox.confidolegal.com/' violates the following report-only
Content Security Policy directive: "frame-ancestors https://*.confidolegal.com
https://pay.sandbox.confidolegal.com". The violation has been logged, but no further
action has been taken.
```

The hosted-field frames inside it are **enforcing**, and are blocked — three times, once per field:

```
Framing 'https://pay.sandbox.confidolegal.com/' violates the following Content Security
Policy directive: "frame-ancestors https://*.confidolegal.com
https://pay.sandbox.confidolegal.com". The request has been blocked.     — hosted-fields.js
```

`frame-ancestors` matches the whole ancestor chain, so our origin at the top of
`our-app → pay.sandbox.confidolegal.com → hosted-fields` blocks the innermost frames even though the
outer page loaded.

**What we need:**

1. **Confirm that registering an origin under Trusted Domains adds it to the `frame-ancestors` list
   above**, for the hosted-field frames and not only the outer page — and that the same registration
   covers `onboarding.js`.
2. **Can a local development origin be registered at all?** Ours is `http://localhost:5173`: plain
   HTTP, and not a domain anyone can prove ownership of. If it cannot, please say so plainly — we
   will route developers through a tunnel instead. Right now this fails as a silent spinner with no
   error a developer can act on, which is an expensive way to learn it.
3. Which origins should we register for sandbox versus production, and does a wildcard work for
   preview deployments (`*.vercel.app`-style hostnames that change per branch)?

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

### 13. Chargebacks appear to have no webhook at all

_(Numbered out of sequence, to keep the numbers above stable.)_

`TransactionStatus2.CHARGED_BACK` exists, and `sandboxOnlyTriggerChargeback` exists, but
`docs/webhooks/webhook-types` lists no `transaction.charged_back` event. The documented set is:

```
transaction.created           transaction.voided
transaction.funds_in_transit  transaction.refunded
transaction.deposited         transaction.partially_refunded
                              transaction.ach_returned
```

A chargeback moves money out of a firm's account with no action by the firm, so it is the reversal
we most need to hear about and the only one with nothing to announce it.

**The questions:**

1. Is there a chargeback webhook that is simply undocumented?
2. If not, does `transaction.created` fire for the chargeback transaction? We recognise reversals
   structurally — any transaction carrying `originalTransactionId` is treated as one — so if
   `transaction.created` fires we would record it correctly without needing a named event.
3. Is `transaction.charged_back` planned?

We could not settle this ourselves: `sandboxOnlyTriggerChargeback` refuses with _"must be card
transaction"_, and every transaction our scripts can create is a `manualPayment`. Reaching a real
card transaction means a payer entering card details on the hosted page.

**The workaround we have shipped:** monthly statement ingestion. A chargeback appears as a debit
line whether or not an event announces it — but that is reconciliation after the fact, not
notification, and the gap is a month wide.

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
