# Questions for Confido Legal support

Compiled from building the integration (firm onboarding + taking payments) against the sandbox.
Grouped by what they block. Everything here is something we could not answer from the docs or by
experiment.

**Context:** we are a partner integration (legal intake platform). Our firms will be onboarded
through `onboarding.js`, take payments through hosted Payment Links embedded in an iframe on our
domain, and we record each transaction into our own trust/operating ledger. We are deploying on
your **updated platform** — that is confirmed, and the questions below assume it.

> **Status, August 2026.** Confido answered this batch (raw reply kept outside the repo). Their
> answers are recorded inline below, marked **ANSWERED**. Four things were **not** answered and are
> collected at the bottom under "Still outstanding" — including chargebacks, which was the most
> important question here and got no response at all.
>
> What changed in the code as a result is small: nothing already shipped was wrong. See the commits
> on `feat/confido-support-followups`.

---

## Blocking — we cannot build these without an answer

_(Question 2 below is now resolved; kept in place so the numbering matches earlier correspondence.)_

### 1. Connect (OAuth) — ANSWERED, and this unblocks the flow

We can see `firmApiTokenExchangeCode(input: { code, nickname })` in the schema, and the docs
describe Connect at a high level, but nothing documents how a partner actually gets a `code`.

- **What is the authorize URL**, and what query parameters does it take?
- **Is the `state` parameter round-tripped back to our callback verbatim?**
- **Do redirect/callback URIs have to be registered** with you in advance, and if so where?

**Their answer:**

- The Connect URL is **partner-specific**, found in Partner Portal → Settings → Connect. There is no
  shared base URL — each partner gets their own.
- **No required parameters.** `state` is optional and may be any string.
- **`state` is returned to the callback exactly as sent**: `?code=<code>&state=<your_state>`.
- **Callback URLs must be pre-registered** in the Partner Portal under Settings → Connect.
- Exchange the code with `exchangeCodeForFirmApiToken` using the Partner API Token. They noted we
  had referenced `firmApiTokenExchangeCode` and said to _"confirm the mutation name against the
  GraphQL playground, but the behavior matches."_

**What this changes:** the verbatim `state` round-trip was the whole reason we did not ship Connect.
It is now buildable — the callback can derive the organization from a state we signed, so an
attacker-supplied code cannot bind their merchant account to another firm's organization.

**To action:** the authorize URL is a per-partner, per-environment value, so it becomes an env var
rather than a constant. Callback registration is an ops step for sandbox and production separately,
and must be a stable backend origin (per-branch preview URLs cannot be registered). Confirm the
mutation name in the playground before shipping.

### 2. Sponsor bank configuration — RESOLVED (decision), one thing still to action

**Decided: our firms are on the new sponsor bank configuration**, following from Confido's
confirmation that they are all on the newer platform. Refunds therefore debit the **trust account
directly**, and a trust refund moves trust money rather than requiring a manual transfer.

**Confido confirmed the mechanism (Aug 2026):** a refund _"will pull from the account where the
original transaction was deposited."_ Since Confido already emits one transaction per account
credited, a split payment refunds each leg from its own account. This matches what slice 3 already
does — no change.

**Still to action**, and it fails silently until the first refund:

- Each firm's bank must permit Confido's originator IDs to debit their **trust** account:

  ```
  2638633811   9263863381   8263863381
  4263863381   3263863381   2263863380
  ```

  > "If these IDs are not allowed by your bank, the refund may be blocked."

- **Is that list current and complete?** — **NOT ANSWERED.** Still worth confirming, since a firm has
  to take it to their bank during onboarding and a stale ID means a blocked refund months later.

### 3. Trusted Domains — PARTIALLY ANSWERED, still blocking us today

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

**Their answer, in full:** _"You will want to add a trusted domains in your Confido partner account
under Settings > Trusted domains."_

That restates where the setting is and answers none of the three questions. **All three are still
open.** We can settle (1) ourselves by registering our sandbox origin and re-testing the iframe;
(2) and (3) need Confido, and (2) in particular costs every new developer an afternoon.

---

## Important — we have shipped a defensive workaround, but would rather not guess

### 4. Surcharging on the updated platform — ANSWERED, as we assumed

> "Yes, your firms will all be on the newer platform, so **no surcharge will be deposited**. You can
> still initiate refunds on them and firms can still see the surcharge amounts in their reporting."
> — Emery Wager, 18 Aug 2026

Follow-ups, all confirmed:

- **Does a surcharged payment still return a non-zero `Transaction.surchargeAmount`?** — **Yes.**
- **Is `amountProcessed` still exclusive of it?** — **Yes.**
- **`surchargeAmount` vs `legacySurchargeAmount`?** — _"You will want to use the new one."_

**No change needed:** we already query `surchargeAmount` (not the legacy field) and credit
`amountProcessed / 100` to the invoice.

### 5. Fee debits against insufficient funds — ANSWERED

Fees are debited monthly from the account carrying `isFeeAccount`. We now set that explicitly to the
firm's operating account.

- **What happens when that debit fails for insufficient funds?** — _"The firm will be put on hold and
  we will reach out to the firm to make the payment."_
- **Retry cadence?** — **NOT ANSWERED.**
- **Can a failed fee debit ever fall back to the trust account?** — _"We never pull fees from
  trust."_
- **Does repeated failure move the firm to `SUSPENDED`?** — **Yes.**

**This was the answer we most needed.** A processing fee reaching an IOLTA account is a bar
complaint, not an accounting problem, and it is now explicitly ruled out.

### 6. `FirmStatus.SUSPENDED` — ANSWERED

`SUSPENDED` is in the `FirmStatus` enum but appears in no documentation.

**Their answer:** _"Suspended means all processing activity stops. This happens in cases of suspected
fraud, extended non-payment of fees or other suspicious activity. The firm cannot remove themselves
from this state. The Confido team needs to clear them."_

**No change needed:** `stateForStatus` already maps `SUSPENDED → suspended`, `canAcceptPayments`
already returns false for it, and the settings page offers no retry button in that state. The only
sharpening available is copy — saying plainly that only Confido can lift it.

---

### 13. Chargebacks appear to have no webhook at all — NOT ANSWERED

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

**The workaround we have shipped:** monthly statement ingestion. A chargeback appears as a debit
line whether or not an event announces it — but that is reconciliation after the fact, not
notification, and the gap is a month wide.

> **This received no response.** It is the highest-value question in this document and should be
> re-asked on its own rather than inside another batch.

#### We tried to answer it empirically — 24 Aug 2026

The earlier note here said we could not settle this because
`sandboxOnlyTriggerChargeback` refuses with _"must be card transaction"_ and every transaction our
scripts can mint is a `manualPayment`. We cleared that bar and hit a different one underneath.

**What we did.** A throwaway sandbox firm (`4a95841d-fa91-40e7-a701-eafb0c86ec77`), a split Payment
Link (`d74c1695-585d-4fc1-8949-811f0a494114`, $30.00 trust / $20.00 operating), and **a real card
payment typed into the hosted page** — Visa, `paymentMethod: CREDIT`. The hosted page works fine when
opened directly; the CSP problem in Q3 only blocks _framing_ it, which is worth knowing on its own,
because it means manual testing is not blocked on Trusted Domains.

**What we confirmed on the way.** Nothing new, but all of it now verified against a real card
payment rather than a `manualPayment`:

- One transaction per credited account, both carrying the same `payment.id` as the correlator.
- Both `originalTransactionId: null` — payments, not reversals.
- The settlement ladder runs `PENDING → FUNDS_IN_TRANSIT → DEPOSITED`, each step emitting its own
  webhook, and the sandbox advances a card payment on its own timeline without being pushed.
- **Webhooks reach us reliably.** Five events on this firm, which is what makes the negative below
  meaningful rather than ambiguous.

**Where it stopped.** With the trust leg at `DEPOSITED` and `settledOn` populated:

```
sandboxOnlyTriggerChargeback(input: { transactionId: "4ef5fb9d-…", amount: 3000 })
  -> unsupported processor: emergepay_card
```

The sandbox **UI returns the same error**, so this is not an API-only restriction.

**And we cannot configure around it.** `CreditCardProcessor` is
`adyen | emergepay | emergepay_sandbox | epmock`, but **no `INPUT_OBJECT` in the schema exposes a
processor field** on a firm or a payment — we checked all of them. A partner has no way to provision
a firm onto a processor that supports chargeback simulation.

**So the question stays open, but the ask is now much stronger:** this is a reproducible defect in
Confido's own tooling rather than a question about their documentation, which is a great deal harder
to skip.

#### A second finding, arguably worth more than the original question

Introspecting the sandbox mutations turned up two that appear in no documentation we have found:

```
sandboxOnlyTriggerChargebackReversal   (transactionId, amount)
sandboxOnlyTriggerPrearbitrationLost   (transactionId, amount)
```

**A chargeback can be reversed** — money clawed back, then returned when the firm wins the dispute —
and pre-arbitration means there is at least a third stage beyond that. Our reversal model treats a
reversal as terminal: signed negative rows, no un-reversal. Money returning after a won dispute is a
case we have never modelled.

Had we only ever got an answer to "is there a chargeback webhook", we would have built for a single
event and been wrong about the shape of the thing. Whatever we ask next must cover the **lifecycle**,
not one event in it.

**Reproduction scaffolding** is kept outside the repo (session scratchpad): provisioning, transaction
capture, the settle/chargeback driver, and a webhook-arrival observer. The probe firm is still live
and its **operating leg is unspent**, so if Confido enables the processor the test can be finished
without asking anyone to type card details again.

## Confirmations — we believe we have these right, but they are load-bearing

### 7. Statement amounts are in cents — ANSWERED, confirmed

`StatementDebit.amount` and every `StatementBankAccount` fee field are typed `Float!`, while
`StatementAdditionalCredit.amount` is typed `Int!` — in the same object.

**Their answer:** _"Yes, all statement monetary values are in cents. Your example of 2500 = $25.00 is
correct."_

**No change needed:** `statements.service.ts` divides every statement amount by 100.

### 8. `externalId` uniqueness — ANSWERED, and broader than we asked

We use `externalId` as our idempotency key — our invoice id on a Payment Link, and our client/lead id
on a Client — and look records up by it before creating.

**Their answer:** external ids must be unique **across the whole platform, not per firm**. This is
described as a known issue. A duplicate _"will fail with a constraint error that surfaces as a 500.
Treat it as permanent (not retryable)."_ They recommend prefixing with the firm's customer id to
make ids globally unique.

They also volunteered that **`removePaymentLink` exists** (single `id` input), with one constraint:
it is _"rejected if the paylink is referenced by other records (e.g. transactions) — so it only works
on paylinks that have no payment activity against them."_

**What this changes:**

- **Nothing for uniqueness.** Every `externalId` we send is already a v4 UUID — the invoice id on a
  link, the client/lead id on a payer, a fresh `randomUUID()` on a refund. Those are globally unique
  by construction. **Do not adopt the customer-id prefix**: it would re-key every existing link and
  payer and orphan them.
- **The removal constraint matters.** We already use `removePaymentLink` (as `retirePaymentLink`)
  when an invoice is voided, and a _partially paid_ invoice is precisely the case where removal now
  reliably fails. That is handled: the webhook path records a payment against a voided invoice on the
  finance trail and completes, rather than retrying forever.

### 9. `paymentLink(externalId:)` reports "not found" as a 500 — ANSWERED, no fix coming

A missing Client returns `400 USER_INPUT_ERROR`. A missing Payment Link returns **`500
INTERNAL_SERVER_ERROR`** with the message `"Paylink not found"`.

**Their answer:** _"Confirmed — a missing paylink throws a generic Error('Paylink not found') rather
than a typed error, which causes a 500 instead of a 400. This is not intentional. Recommend checking
the error message string to distinguish 'not found' from a real server error — imperfect I know."_

**What this changes:** our string match stays, and is now known to be permanent rather than
temporary. Since the wording can change without notice and a change would make us mint duplicate
links, `scripts/checks/17-confido-payments.ts` now asserts the string against the sandbox.

### 10. Transient "Access denied" on `statements` — ANSWERED, unexplained

Querying `statements` returned `Access denied! You don't have permission for this action!` twice in a
row with both a firm token and a partner token, then worked seconds later with the same firm token
and no changes.

**Their answer:** _"I have not heard of this surfacing before. Any additional details would be great
including timestamps. I would treat it as temporary for now. We'll look into it."_

**What this changes:** `listStatements` now retries twice on this specific message and logs
`occurredAt` on each retry, so we accumulate the timestamps they asked for. Deliberately bounded — a
genuine permission failure reads identically and must still surface.

---

## Minor

### 11. ACH deposit timeline for firms onboarded now — ANSWERED

**Their answer:** _"2 business days for all. They will deposit with the card transactions for that
day."_

**No change needed:** our copy already says "around two business days".

### 12. `firmUpdate` has no `firmId` — ANSWERED, intentional

**Their answer:** _"Confirmed and intentional. For requests authenticated with a Firm API Token,
`firmId` defaults to the firm associated with that token. A PARTNER_ADMIN token must supply `firmId`
explicitly."_

**No change needed:** we call it with a firm token.

---

## Still outstanding

Four things from this batch were not answered. In priority order:

1. **Chargeback webhooks (Q13)** — no response at all. The only reversal that moves money with no
   firm action and no event to announce it. Re-ask on its own. **Now blocked on Confido's side
   rather than ours:** we drove a real card payment to `DEPOSITED` and
   `sandboxOnlyTriggerChargeback` refuses with `unsupported processor: emergepay_card`, from both the
   API and the UI, with no partner-accessible way to change the processor. The re-ask must lead with
   that defect, and must cover the whole **dispute lifecycle** — `sandboxOnlyTriggerChargebackReversal`
   and `sandboxOnlyTriggerPrearbitrationLost` exist and are undocumented, so a chargeback is not
   necessarily final and our reversal model assumes it is.
2. **Trusted Domains (Q3)** — all three sub-questions unanswered: whether registration reaches the
   hosted-field `frame-ancestors` list, whether `http://localhost:5173` can be registered, and
   whether wildcards work for preview deploys.
3. **ACH originator ID list (Q2)** — is the published list current and complete?
4. **Fee debit retry cadence (Q5)** — how often a failed monthly fee debit is retried before the firm
   is suspended.
