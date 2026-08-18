# Confido Legal — Phase 2, Slice 2: taking money

## Context

Slice 1 (merged) lets a firm onboard to Confido and tracks underwriting. It moves no money.
Slice 2 makes payments real: a client opens an invoice link, pays on an embedded Confido page, and
the money lands split across the firm's trust and operating accounts with our ledger agreeing.

The sandbox spike settled the mechanics (`oravanti-backend/confido_legal_integration.md`). The two
that drive this design:

- **Confido emits one transaction per account actually credited.** A payment touching both accounts
  produces two transactions; one touching only trust produces one.
- **Confido allocates partial payments trust-first**, cumulatively — matching the policy we chose,
  so our ledger cannot drift from theirs.

### Settled already

| Decision | Choice |
|---|---|
| Receipts | Confido sends them (`sendReceipts: true`); we send none |
| Payment link creation | Lazy — on first page load, idempotent via `externalId` = invoice id |
| Surcharging | **Firm-level option, default off.** Mirrors Confido's own setting rather than a copy |

---

## The ledger model

**One `invoice_payments` row per credited leg, single-sided.** Each row's `amount` is that leg's
amount, so `sum(amount)` is still the money received. This is the single most important invariant
in the change: `totals.ts` folds `sum(invoicePayments.amount)` into `invoices.amount_paid`, and if
both legs carried the full payment every figure in the app would double.

The existing constraints already fit, unchanged:
- `invoice_payments_split_balances` (`amount_operating + amount_trust = amount`) — a single-sided
  row satisfies it trivially.
- `invoice_payments_amount_positive` (`amount > 0`) — which is why **a zero leg must produce no row
  at all**, rather than a `0.00` row.

### Worked scenarios

Take the fixture invoice used by `12-finance`: **trust 1,440** (USCIS filing fee) + **operating 500**
(attorney time) = **1,940**.

**A — trust only.** Client pays 500. Trust-first sends all of it to trust (1,440 outstanding).

| | |
|---|---|
| Confido | 1 transaction — trust, 50000 cents |
| We write | 1 row: `amount 500, amount_trust 500, amount_operating 0` |
| Invoice | `amount_paid 500`, `balance_due 1,440`, status `partial` |

**B — both.** Client pays the full 1,940.

| | |
|---|---|
| Confido | 2 transactions — trust 144000, operating 50000 |
| We write | 2 rows: `(1440, trust 1440, op 0)` and `(500, trust 0, op 500)` |
| Invoice | `amount_paid 1,940` (1440 + 500), `balance_due 0`, status `paid` |

**C — operating only.** Trust was funded earlier; client now pays the remaining 500.

| | |
|---|---|
| Confido | 1 transaction — operating, 50000 |
| We write | 1 row: `amount 500, amount_trust 0, amount_operating 500` |
| Invoice | `amount_paid 1,940` cumulative, status `paid` |

In all three, `sum(amount) == money received` and `sum(amount_trust) == money in trust`. The Reports
tab's trust figure (`reports.service.ts` sums `amount_trust`) stays correct without change.

### Surcharge — a firm-level option, defaulting to off

Confido gates surcharging twice, and we should mirror that rather than invent our own switch:

1. **Confido enables the capability per firm** — `PaymentSettings.surchargeAllowed` /
   `FirmSettings.approvedForSurcharge`. A firm that has not been approved cannot turn it on, and the
   knowledgebase says so plainly: *"If you do not see this option in Settings > Firm Settings,
   contact support@confidolegal.com to enable surcharging."*
2. **The firm then toggles it** — `PaymentSettings.surchargeEnabled`, which we set through
   `paymentSettingsUpdate({ firmId, surchargeEnabled, surchargeDefaulted })`.

**The firm can only enable surcharging if Confido has approved them for it.** That is the gate, and
it is Confido's to grant, not ours — so `surchargeAllowed` is read every time rather than cached,
and the toggle is not merely hidden when false but genuinely unavailable: `PATCH
/settings/payments/surcharge` re-reads `paymentSettings` and refuses with a 409 if the firm is not
approved, so the API cannot be talked into a state the UI would not offer.

The Payments tab renders three states: **not approved** (explain that Confido must enable it, point
at support), **approved and off** — the default, a toggle — and **approved and on**, showing the
rate. Confido stays the source of truth; we store no copy, so the two cannot drift.

Consequences to encode:

- **Stop hardcoding `surchargeEnabled: false` on payment links.** Omit the field so the firm's own
  setting applies. Per-link and per-client overrides exist in Confido's UI and we do not need to
  duplicate them.
- **The rate is fixed at 3.00% and not firm-editable** — only Confido can change it. The UI must
  display it, never offer to edit it.
- **Debit cards are never surcharged**, by card-brand rule. Confido applies it only to confirmed
  credit cards, so a firm enabling it will see it apply unevenly. Worth saying in the UI.
- **Link to Confido's surcharging-guide-by-state.** Legality varies, and the firm is the one taking
  the risk.

### The transaction shapes surcharge produces

Documented precisely, and they matter because our webhook records a ledger leg per transaction:

| Invoice | Client's card statement | Where money lands |
|---|---|---|
| Operating $100 | one charge, $103 | $103 → operating |
| Trust $100 | **two charges, $100 and $3** | $100 → trust, $3 → operating |
| Split: $200 trust + $100 operating | two charges, $200 and $109 | $200 → trust, $109 → operating ($100 + $3 own surcharge + $6 trust's surcharge) |

Two things follow. First, **all surcharge lands in operating, never trust** — so there is no
commingling, and the earlier objection on that ground was wrong. Second, **a trust-only invoice
produces an operating-side transaction that is not invoice revenue**, and a split invoice produces
an operating transaction inflated by both surcharges.

The API view is friendlier than the card-statement view: `Transaction.surchargeAmount` is documented
as *not* included in `amountProcessed`. So recording each leg's `amountProcessed` stays correct and
the surcharge does not inflate `amount_paid`. But that leaves the standalone $3 transaction on a
trust-only link unaccounted for, and **how it presents has not been observed** — it may carry
`amountProcessed: 0, surchargeAmount: 300`, or the reverse. The check script must settle this before
surcharging is offered to any firm.

**Confirmed by Confido support (18 Aug 2026):** *"your firms will all be on the newer platform, so
no surcharge will be deposited. You can still initiate refunds on them and firms can still see the
surcharge amounts in their reporting."*

So there is **no separate surcharge transaction** to mistake for invoice revenue. The hazard
described above is the legacy platform's, not ours. The webhook allowlist stays anyway — it costs
nothing, and "no transaction is created" is a thing that could change without us hearing about it.

What remains open is only whether a surcharged payment still reports a non-zero
`Transaction.surchargeAmount` alongside an exclusive `amountProcessed`. Since we credit the invoice
with `amountProcessed`, that distinction is what keeps a surcharged payment from being recorded as
larger than it was.

### Who pays the processing fee

Distinct from surcharge, and the answer to "where does the firm get the money".

Deposits are **gross**: a $500 trust payment puts the full $500 in trust. Fees are never netted out
of a deposit — that is precisely what would create a trust shortfall, and why a legal-specific
processor exists at all. Instead Confido accumulates fees and debits them **monthly** from a
designated fee bank account (`BankAccount.isFeeAccount`, set via `FirmUpdateInput.feeBankAccountId`).

**We never set that.** Nothing in the codebase references `feeBankAccountId` or `isFeeAccount`, so
every firm onboarded so far uses whatever Confido defaults to. Slice 2 fixes this early: after
activation, read `bankAccountsList` and call `firmUpdate({ feeBankAccountId })` with the operating
account if it is not already set there. Small change, bad failure mode if left.

### What reconciles against what

| Account | Reconciles against | Exact? |
|---|---|---|
| **Trust** | `sum(amount_trust)` | **Yes** — gross deposits, fees never touch it |
| **Operating** | `sum(amount_operating)` − the monthly fee debit | **No**, not without the statement |

Processing fees are a firm operating expense, not an invoice payment, so they correctly appear
nowhere in `invoice_payments`. The operating account will show a monthly ACH debit our ledger knows
nothing about. Closing that needs `statement.created` ingestion — `StatementDebit` gives `amount`,
`fromBankAccountCategory` and `statementDescriptor`, which is exactly a reconciliation line. That is
**in scope for this slice** (see §5b), so no month goes unrecorded.

**Open, for Confido support:** what happens when the monthly fee debit hits insufficient funds.
`FirmStatus.SUSPENDED` is the obvious destination and is undocumented. The question that needs an
explicit answer is whether a failed debit can ever fall back to another account — if it could reach
trust, that changes our posture entirely.

---

## What the knowledgebase changed

The API docs describe mechanics; the knowledgebase describes money movement, and it contradicts
some assumptions. Four findings, in descending order of how much they cost if missed.

**1. Refunds come out of the OPERATING account, not trust — on the legacy configuration.**

> "The refund amount is withdrawn from your operating account and sent to your client. You must then
> transfer the same amount from trust to operating to balance the accounts."

Trust accounts were historically set up to block all debits, which is exactly the safeguard you want
and exactly what makes refunds awkward. On the newer sponsor-bank configuration refunds debit trust
directly, provided the firm's bank allows Confido's originator IDs.

This is **slice 3's biggest problem**, and it is worse than the API suggested. The spike observed a
trust-leg refund reducing `trustPaid` on the payment link — but that is Confido's ledger view, not
the bank movement. On legacy, the trust bank balance does not change and the firm owes itself a
manual transfer. A refund ledger that mirrors Confido without modelling that will disagree with the
trust bank statement, which is the one reconciliation that must never drift.

**2. `TransactionStatus2.HELD` is a high-dollar risk hold**, previously unexplained. Payments that
deviate from a firm's normal pattern are held pending documentation, cleared manually by Confido
support, then deposited a business day later. **Filing fees are exactly the kind of large, atypical
payment that triggers this** — a new firm's first USCIS fee could sit held. `HELD` must not read as
paid, and the case-opening gate must not open on it.

**3. Deposit timing is slower than "same-day ACH" implies.** Cards deposit in 2 business days;
same-day ACH is same-day only before a 3pm ET cutoff, **and firms onboarded after September 2025 are
on a +2 business day ACH timeline regardless**. Card cutoff is 11:30pm ET. This is the gap between
"the client paid" and "the firm has the money", and it is what slice 3's settlement-aware gate is
actually about.

**4. ACH returns are retryable.** R01 (insufficient funds) may be retried "up to two more times
within 30 days". So a returned payment is not necessarily final, which argues for modelling returns
as reversing entries rather than deletions — the shape slice 3 already plans.

**Confirmed: we deploy on the updated platform.** The sponsor-bank axis is still open — the two are
described in separate articles and may be independent — and it is question 2 in
`confido_support_questions.md`.

What that assumption buys:

- **Surcharge produces no separate transaction.** On the updated platform *"firms will not receive
  any surcharge amounts — Confido will hold the surcharge amounts and apply them to the firm's
  processing fees."* So the trust-only $100 + $3 case is one transaction of $100, with the surcharge
  recorded but never deposited. The overpayment hazard largely dissolves. The allowlist in the
  webhook handler stays anyway — it costs nothing and the assumption is unverified.
- **Refunds debit trust directly**, so a trust refund moves trust money and the ledger matches the
  bank without a manual transfer. That is the good case for slice 3, and it removes the worst
  reconciliation problem the knowledgebase turned up.

**But it adds an onboarding requirement.** For refunds to work on the new configuration, the firm's
bank must permit Confido's originator IDs to debit the trust account:

```
2638633811   9263863381   8263863381
4263863381   3263863381   2263863380
```

> "If these IDs are not allowed by your bank, the refund may be blocked."

This is a thing the firm must arrange with their own bank, and it fails silently until the first
refund. The Payments settings tab should state it as a prerequisite once a firm is active — cheap to
add, and the alternative is discovering it during a client refund.

---

## Backend

### 1. Retire the Stripe seam rather than contort it

`payment.provider.ts` was drawn around Stripe and is wrong in four ways for Confido: `PaymentEvent`
carries a single `amountCents` with no account, `parseEvent` returns one event where Confido posts
an array, `getPaymentProvider()` caches a **module-level singleton** where Confido is credentialed
per firm, and `isPaymentProviderConfigured()` reads `STRIPE_*`.

Keeping both seams would leave **two unauthenticated endpoints that can write to the ledger**. So:
delete `payment.provider.ts`, `payment-webhooks.service.ts`, `PaymentWebhookRouter` and the
`/webhooks/payments` mount in `app.ts`, and point `payment-links.service.ts` at the Confido module
directly. `/webhooks/confido` becomes the only path money arrives on.

### 2. Readiness becomes per-organization

`isPaymentProviderConfigured()` is global; Confido readiness is per firm. Replace with
`paymentsEnabledFor(organizationId)` in the Confido module: platform configured **and**
`confido_firms.is_accepting_payments` for that org — the `canAcceptPayments` gate slice 1 already
defines. Feeds three call sites: `paymentsEnabled` on the payable invoice, the `startCheckout`
guard, and the emailed-link gate in `deliveries.service.ts:280` (which has `organizationId` in
scope already).

That last one matters: today `paymentUrl` is always null, so **no invoice email has ever contained
a pay link**. The moment this flips, every send mints and rotates a token.

### 3. Confido clients, keyed by `externalId`

`addPaymentLink` requires a Confido `clientId`, but consultation invoices are raised against a
**lead** — `invoices` has `check((client_id IS NOT NULL) <> (lead_id IS NOT NULL))`.

No new table: Confido's `client(externalId:)` query means our own uuid is the key. `ensureConfidoClient`
looks up by `externalId` (the invoice's `client_id` or `lead_id`) and creates on miss. Idempotent,
survives `openCase` repointing `lead_id → client_id` (the old lead-keyed Confido client simply stops
being referenced).

### 4. Payment links, lazily and idempotently

New firm-level client methods matching `createOnboardingToken`'s shape: `getPaymentLinkByExternalId`,
`addPaymentLink`, `getTransaction`. `addPaymentLink` carries the same **never retry** warning as
`createFirm`.

`startCheckout` becomes get-or-create: look up by `externalId = invoiceId`, else create with
`trust`/`operating` shorthand from the invoice's outstanding split, `surchargeEnabled: false`,
`sendReceipts: true`. Returns the hosted URL for the iframe.

### 5. `transaction.*` webhooks

`ConfidoWebhookJob` currently carries only `{ eventId, eventType, firmId }` — the transaction id is
dropped at enqueue. Add `transactionId`, extracted from `event.data`, and extend `HANDLED_TYPES`
with `transaction.created`, `transaction.funds_in_transit`, `transaction.deposited`.

The worker queries the transaction, reads `paymentLink.externalId` for our invoice id, and calls
`recordPayment` with an explicit single-sided split plus the leg's own transaction id as
`providerReference` — which keeps `invoice_payments_provider_ref_uidx` working as the replay guard,
since each credited account has its own transaction id.

`transaction.created` is the ledger write. The settlement events only advance status, and slice 3
uses them for the case-opening gate.

**Two transactions reaching an invoice are not always two legs of it.** Before recording, the
handler must skip anything that is not invoice revenue — a standalone surcharge transaction being
the known case (see above), and refunds/returns being slice 3's. Getting this wrong overpays the
invoice rather than failing loudly, which is the worst shape of bug for a ledger. The safe default
is an allowlist: record only transaction types we recognise as a client payment, and log-and-skip
anything else so an unrecognised type is visible rather than silently booked.

### 5b. Statement ingestion — so operating reconciles

Processing fees never reach `invoice_payments`, and correctly so: they are a firm expense, not a
client payment. But that leaves a monthly debit sitting between our operating figure and the bank
balance. Ingesting statements closes it, and doing it now means no month goes unrecorded.

**Two new tables**, both org-scoped with RLS policies mirroring `confido_firms`:

- `confido_statements` — `organization_id`, `confido_statement_id` (unique), `month` (`YYYY-MM`),
  `payment_volume`, `total_fees`, `fees_paid_by_clients`, `net_fees`, plus a `bank_accounts` jsonb
  for the per-account breakdown. Effective rate is `net_fees / payment_volume` and is derived, not
  stored — it is a ratio of two columns we already have.
- `confido_statement_debits` — `statement_id`, `amount`, `from_bank_account_category`,
  `from_bank_account_mask`, `statement_descriptor`. Its own table rather than jsonb because "what
  did we pay in fees this year" is a query, and these are the reconciliation lines.

Money as `numeric(15,4)`, per house convention.

**Do not store `pdfUrl`.** It is short-lived and the docs warn against emailing it; fetch it on
demand if the UI ever offers a download.

Webhook: add `statement.created` and `statement.updated` to `HANDLED_TYPES`, upserting on
`confido_statement_id` so an update replaces rather than duplicates.

**Two API hazards here, both worth knowing before writing the mapper:**

1. **There is no `statement(id:)` query.** Only `statements(limit: Int!, startMonth, endMonth,
   offset, orderDir)`. The webhook carries just `statement.id`, so the handler fetches a recent
   window and matches by id. Workable, but it means a statement older than the window is
   unreachable by webhook alone.
2. **The money types are inconsistent within the same statement.**
   `StatementAdditionalCredit.amount` is `Int!` while `StatementAdditionalFee.amount` is `Float!`,
   and every `StatementBankAccount` fee field plus `StatementDebit.amount` is `Float!`. One of these
   is probably cents and the others dollars — mixing them is a 100× error on money. **Settle it with
   `sandboxOnlyCreateMockStatement` before trusting any of it**, and do not assume the mock's random
   values share the real units.

### 6. `recordPayment` takes legs

`RecordPaymentInput` gains an optional `legs: Array<{ account, amount, providerReference }>`. When
present: insert one row per leg, **skip zero legs**, `requireTrustWrite` once if any leg is trust,
then `recalculateInvoiceTotals` **once** after all of them, inside the existing `withTransaction` —
recalculating per leg would emit a spurious intermediate `partial` and a duplicate
`invoice_partially_paid` event. One `logFinanceEvent` per client payment, not per leg.

Manual staff entry keeps its current single-payment shape.

### 7. `proRateSplit` → `trustFirstSplit`

`money.ts`: `trust = min(amount, trustOutstanding); operating = amount - trust`, keeping the
`trustOutstanding <= 0 → all operating` branch so an overpayment on a settled invoice lands in
operating, which is firm revenue rather than client money.

One production caller (`payments.service.ts:95`). The stale prose reference at `instalments.ts:68`
needs updating — trust-first never produces a remainder.

### 8. Retire the consultation demo-pay button

`payConsultationFee` (`leads.service.ts:3216`) flips `feeStatus` without money moving, and its own
doc comment says a provider replaces it. Replace with a real payment link against the consultation's
invoice; `feeStatus` becomes derived from the invoice, which `consultationFee()` already does.

Two existing bugs surface here and should be fixed with it: the instant path tags the lead event
`demo: true` but the urgent and standard paths do not, so those read as genuine settlements; and
`updateBookingTimezone` (`leads.controller.ts:495`) never calls its service at all.

Note a consultation can have `feeStatus: "unpaid"` and `invoiceId: null` (lead has no practice
area, or the raise threw and was swallowed) — the new path must handle that rather than assume.

---

## Frontend

### 9. The payment page becomes an embed

`src/pages/invoice-payment/index.tsx`: replace `window.location.href = session.url` with
`chakra.iframe`, following the only existing precedent
(`send-invoice-dialog.tsx:160-196` — bordered `Box` with `overflow="hidden"` owning a responsive
height, iframe at `w/h 100%`, `border="none"`, a `title`). The `maxW="480px"` card has to grow.

**The polling trap.** `invoiceByPaymentToken` throws `BadRequestError` once `balance_due <= 0`, so a
naive poll flips the page into the "link is not available" error card at the exact moment payment
succeeds. Fix on the backend: return a terminal `settled` state in `PayableInvoice` instead of
throwing, and let the page render a success panel. The throw stays for genuinely bad tokens.

Poll with `refetchInterval` as a function of the query, mirroring `use-payment-settings.ts:20-31`,
but at ~3s rather than 30s — a payer is watching a card go through — returning `false` once settled.
Note the query sets `retry: false`, so a transient 500 mid-poll would surface as the error card;
polling needs a small retry allowance.

### 10. Surcharge control on the Payments tab

A Surcharge section reading `paymentSettings`, rendering not-approved / approved-and-off (default) /
approved-and-on, with a toggle calling a new `PATCH /settings/payments/surcharge`. Shows the fixed
3.00% rate without offering to edit it, notes that debit cards are never surcharged, and links
Confido's surcharging-guide-by-state — the firm carries the legal risk, so it should be one click
from the switch.

### 11. Statements in Reports

A Statements section in the finance Reports tab: month, payment volume, total fees, net fees,
effective rate, and the debit lines with the account each was taken from. This is what makes the
operating account reconcilable — the debit line is the missing entry.

The existing operating figure should also be labelled **"collected from clients"** rather than
implying a balance, the same honesty the trust figure already applies with `disbursementsTracked:
false`. Ingesting statements explains the gap; it does not make the two numbers the same thing.

### 12. Consultation booking page

Replace the one-click demo button and its three "This is a demo payment" strings
(`consultation-booking/index.tsx:301-304`) with the same embedded flow.

---

## Tests that change, and to what

Precisely two assertions encode proportionality; everything else survives:

| Where | Currently | Becomes |
|---|---|---|
| `money.test.ts:65-66` | `proRateSplit(600, 500, 1500)` → trust 450 / op 150 | trust 600 / op 0 |
| `12-finance.ts:236-237` | same figures | same change |
| `12-finance.ts:707` | `toMoney((940*1440)/1940)` = 697.73 | `min(940, 1440)` = **940** |

`12-finance.ts:696-702` destructures `[storedSplit]` from an **unordered** select that happens to
return one row today. Per-leg rows make it non-deterministic — needs an `orderBy` and a row-count
assertion.

The `payment provider seam` section (`:2198-2236`) asserts the stub is *not* configured; with the
seam deleted it is rewritten against `paymentsEnabledFor`. Two of its assertions currently pass for
the wrong reason (the error thrown changes identity), which the rewrite fixes.

The stats, aging, reports and trust-gating sections are **split-invariant** — they read
`invoices.subtotal_*` and `amount_paid`, never `amount_operating`/`amount_trust`. They break only if
per-leg rows double-count, which is exactly what makes that the invariant to test hardest.

## Verification

- `npm run typecheck` both repos; `npm run lint` frontend.
- `npm run test:unit` — updated `proRateSplit` block.
- `npm run check 12-finance` — the numbers above.
- `sandboxOnlyCreateMockStatement` / `sandboxOnlyUpdateMockStatement` to drive statement webhooks,
  and to settle the Int-vs-Float units question before the mapper is trusted.
- New `scripts/checks/17-confido-payments.ts`: the three scenarios above end to end against the
  sandbox — trust-only, operating-only, both — asserting row counts, per-row splits, `amount_paid`,
  and that a redelivered `transaction.created` is a no-op.
- Manually: pay a real sandbox link from the embedded page and watch the tab settle without a
  reload. Needs `npm run worker` running.
- I will not run the backend jest suite — it hangs this machine.
