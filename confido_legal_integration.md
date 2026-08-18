# Confido Legal — sandbox spike & integration review

## Context

The team and client have moved off Stripe because it can't handle **trust (IOLTA) accounts**
— client money that passes through the firm on its way to an agency must never land in the
firm's operating account. Confido Legal is purpose-built for this: it routes a single client
payment into separate trust and operating bank accounts at the processor.

**The good news, established up front: there is no Stripe SDK in this codebase.** `stripe` is
not in either `package.json`; nothing imports it. What exists is a deliberately empty seam —
`PaymentProvider` + `StubPaymentProvider` in
`oravanti-backend/src/modules/finance/payment.provider.ts`, three unset `STRIPE_*` env vars,
and the ledger idempotency machinery (`invoice_payments.provider`/`provider_reference` unique
index, `payment_webhook_events` store). `StubPaymentProvider.verifyWebhook()` returns `false`
unconditionally and every money path checks `isPaymentProviderConfigured()` and refuses.

So this is not a migration. **Nothing needs ripping out; the seam needs filling in** — and the
seam's shape was drawn around Stripe's assumptions, several of which do not hold for Confido.

This plan covers the **sandbox spike only**: a throwaway harness that proves firm onboarding
and trust-vs-operating routing behave the way we need, and settles the questions Confido's
docs leave open. Production implementation gets planned once the spike answers them.

Doc research is already done. Confido's published docs are thin on the GraphQL surface — they
defer to the playground — but **the sandbox endpoint allows unauthenticated introspection**, so
the full 276-type schema was pulled and is the basis for everything below.

---

## Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Firm onboarding | **Embedded `onboarding.js` + Connect** | New firms never leave our app; Connect (OAuth) for firms already on Confido. |
| Payment surface | **Confido Payment Links, embedded in an iframe** | Only surface that can split trust/operating. There is no return URL, so embedding avoids stranding the payer on Confido's page. ⚠️ Blocked on a CSP `frame-ancestors` question — see below. |
| Hosted-page branding | **Apply at onboarding** via `firmBrandingUpdate` | The page a client pays on should carry the firm's identity, sourced from our existing firm profile. |
| Partial-payment allocation | **Trust first** | Government/filing fees fill before attorney fees. **Confirmed: Confido does this natively.** |

### On embedded onboarding — you asked for embedded or fully self-hosted custom UI

**Embedded: yes. Fully self-hosted with our own UI: not possible.**

`onboarding.js` does exactly what you want — it injects Confido's application form into a `div`
on our own page, so a new firm never leaves the app:

```js
window.confidoOnboarding.renderForm({
  containerId, token, style, onChange, ownerInviteUrl, disableOwnerInvite, suppressLoadingSpinner
});
```

What we *cannot* do is build the form ourselves against the API. **There is no mutation to submit
the underwriting application.** The introspected `FirmUpdateInput` carries only
`defaultOperatingId`, `defaultTrustId`, `feeBankAccountId` — nothing for EIN, beneficial owners,
bank details or KYC document uploads. Confido deliberately keeps that data inside their own
iframe so partners stay out of KYC/PCI scope. Embedded `onboarding.js` is the closest thing to a
custom UI that exists, and it's the right call — it drops Sign Up Links entirely for net-new firms.

**Styling is limited.** The `style` object accepts `theme.brandColors` (a 50–900 scale) and
`inputBackgroundColor`. That's the whole surface. It happens to match Chakra's colour-scale shape,
so feeding our existing tokens in is straightforward — but we should set expectations that this is
a *themed* Confido form, not our own design system.

Two things this buys us that Sign Up Links don't:
- **`ownerInviteUrl` + `renderOwnerForm`** — beneficial owners (>25%) must supply personal
  information, and by default that link points at Confido's domain. Passing `ownerInviteUrl`
  lets us host that step too, via a page that reads the `o_code` query param and calls
  `renderOwnerForm({ code, containerId, style, onChange })`. The entire flow stays on our domain.
- We control the surrounding chrome, progress and error states through the `onChange` handler.

**Two consequences to plan for:**
- Onboarding tokens live **24 hours**. `renderForm` emits `token_expires_soon` (≤5 min warning)
  and `token_expired`; we need an authenticated endpoint that mints a fresh token via
  `createOnboardingToken` and re-renders, or a firm loses unsaved application progress.
- With Sign Up Links the person completing the link becomes a Confido **Firm Admin with a login**.
  Embedded onboarding creates **no Confido user account**. That matters because some things are
  portal-only: revoking an API token, the branding page (`FirmSettings.brandingPageUrl`), and
  statements. If firms need that access we must call the `inviteUser` mutation
  (`{ email, firstName, lastName, role, firmId }`) explicitly — it won't happen by itself.

### On the payment surface — you asked whether Hosted Fields gets Apple Pay / financing

**No, and it's disqualified on a second, harder ground.**

Confido's Hosted Fields overview states the trade-off explicitly: *"You will need to handle each
payment method and keep your implementation up to date as we release new payment methods (e.g.,
Buy Now, Pay Later, Apple Pay, crypto)."* The SDK's `setActiveForm(type)` accepts only `card`
and `ach`. Payment Links, by contrast, are documented to *"benefit from new Payment Methods we
add in the future, such as client financing and Apple Pay, without additional engineering work."*

The decisive point is separate: **Hosted Fields cannot split a payment across trust and
operating at all.** `PaymentSessionCreateInput` takes a singular `bankAccountId`;
`PaymentSessionCompleteInput` takes a singular `amount: Int!`. Only `AddPaymentLinkInput`
carries `amounts: [AddAmountInput!]` (per-bank-account) alongside the `trust:`/`operating:`
shorthand. Since the trust/operating split is the entire reason for this switch, Payment Links
is the only viable surface. **Going with the hosted Payment Link redirect.**

---

## SPIKE RESULTS — run against the live sandbox

The spike is **written and has run**: `npm run check 14-confido-sandbox`, **45 passed, 0 failed**.
A `CONFIDO_PARTNER_TOKEN` was already present in the backend `.env`, so Phase 0 was already done
and everything below is measured, not inferred.

### The headline: trust/operating routing works exactly as we need

A single payment link created with `trust: 50000, operating: 150000` produced two amount legs
resolved to the firm's default trust and operating bank accounts, and paying it in full produced:

```
transactions per split payment: 2
legs: [{account: "operating", cents: 150000}, {account: "trust", cents: 50000}]
balance: {trustOutstanding: 50000, operatingOutstanding: 150000, totalOutstanding: 200000}
```

`Balance` reports `trustPaid`/`trustOutstanding` and `operatingPaid`/`operatingOutstanding`
separately, which maps directly onto our `subtotal_trust`/`subtotal_operating` columns. **The
core premise of the switch is confirmed.**

### Answers

| Question | Answer |
|---|---|
| Transactions per split payment | **Two — one per bank account.** Our ledger should write one `invoice_payments` row per leg (single-sided), not one row with a computed split. |
| Correlation key | **`Payment.id`** — always populated. `txnGroupId` is populated for *real* payments but comes back `null` for API-recorded manual payments, so it cannot be the universal key. Use each leg's own transaction id as the ledger key and `Payment.id` as the grouping column. |
| Refund of one leg | **Refunds only that leg.** `originalTransactions: ["operating"]`, `refundTransactions: [{operating, 150000}]` — the trust leg was untouched. Per-leg refund rows are the right model. |
| Refund timing | Returned `status: SUCCESS` synchronously; the async `AWAITING_RESULT` path did not trigger here. |
| Surcharge on a split link | `surchargeEnabled` defaulted to **false**, and surcharge was 0 on both legs. Good default, but set it explicitly rather than relying on it. |
| Partial payments | **`partialPayment.allowed` defaults to `true`** with `usingFirmDefault: false`. We must pass `partialPaymentAllowed: false` wherever we don't want a client part-paying a trust deposit. |
| Manual payments | **Always require an explicit allocation** — omitting all of `amounts`/`operating`/`trust` errors with *"Need to define amounts, operating, or trust."* Every staff-recorded payment must carry a split decided by us. Mixing the shorthand with `amounts[]` is also rejected. |
| Onboarding token TTL | **Exactly 24h**, confirmed — the re-mint endpoint is required. |
| Hosted link URL shape | `https://pay.sandbox.confidolegal.com/paylink/<uuid>` |

### Partial-payment allocation: ANSWERED — Confido allocates **trust first**

Settled empirically via `npm run check 15-confido-partial-payment`. A $200 card payment against a
lopsided $500-trust / $1,500-operating link produced:

```
status: partially_paid
trust:     $200.00 paid, $300.00 outstanding
operating:   $0.00 paid, $1,500.00 outstanding

trust first       trust $200.00 / operating $0.00   ← MATCH
operating first   trust   $0.00 / operating $200.00
pro rata          trust  $50.00 / operating $150.00
```

**The processor agrees with the policy we chose.** Trust fills before operating, which is the
IOLTA-safe order and means our ledger and Confido's cannot drift on partial payments or
instalments. This removes the main risk flagged when the policy was picked.

Confirmed a second time with a follow-up **$200 ACH** payment on the same link. The rule holds
cumulatively and across payment methods — trust kept filling rather than the second payment
starting a fresh pro-rata:

```
paid: $400.00 of $2,000.00
  trust:     $400.00 paid, $100.00 outstanding
  operating:   $0.00 paid, $1,500.00 outstanding

trust  $200.00  achPayment / ACH    / PENDING
trust  $200.00  ccPayment  / CREDIT / PENDING
```

Note both legs are **`PENDING`**, ACH and card alike, and each payment carries its own
`txnGroupId` — the group id scopes one payment, not the link.

Two supporting details from the same payment:

- **A partial payment produces one transaction per account actually credited, not per leg
  defined.** $200 landing wholly in trust yielded a single transaction. So the "one row per leg"
  ledger model holds, but the number of rows varies per payment — do not assume two.
- **Real card payments land `PENDING`, not `DEPOSITED`** (`canVoid: true`, `canRefund: false`,
  `settledOn: null`). Only API-recorded manual payments are `DEPOSITED` immediately. Our
  case-opening gate (`feeInvoiceSatisfied`, "nothing overdue and something received") would
  therefore open a case on money that has not settled and can still be voided — see Flag 2.

### ACH returns: ANSWERED — a separate positive row, and only the returned leg

Settled with `npm run check 15-confido-partial-payment -- ach-return`, which settles the ACH
payment (`FUNDS_IN_TRANSIT` → `DEPOSITED`) before returning it, because the docs describe returns
as happening to money that has already landed.

```
before:  trust $400.00 paid, $100.00 outstanding   operating $0.00 paid
after:   trust $200.00 paid, $300.00 outstanding   operating $0.00 paid

trust  $200.00  achReturn   PENDING   code=R01 (Insufficient Funds)  orig=7515e460
trust  $200.00  achPayment  RETURNED  code=R01 (Insufficient Funds)
trust  $200.00  ccPayment   PENDING
```

- **Only the returned leg unwinds.** Trust dropped by exactly the returned amount; the operating
  leg was untouched. The link balance self-corrects — `trustOutstanding` went back up to $300.
- **The original row is not mutated into a negative.** It flips to `status_v2: RETURNED` and gains
  `achReturnCode` / `achReturnReason`.
- **A separate `achReturn` transaction is created with a POSITIVE amount**, carrying
  `originalTransactionId` back to the payment it reverses.

**This is the good outcome for our schema.** `invoice_payments.check(amount > 0)` can stay exactly
as it is. What we need is a `kind` column (`payment | refund | return | void | chargeback`) plus a
self-reference to the row being reversed — mirroring Confido's own shape rather than inventing a
signed-amount ledger. One caveat: because the reversing row is positive, it **must be excluded
from, or signed at, the `amount_paid` rollup** in `recalculateInvoiceTotals`, or a returned payment
will read as two payments.

### Two new findings, neither documented

**A. `createFirm` returns a stale payload.** Its response says `status: CREATED,
isAcceptingPayments: false`; re-querying the same firm moments later returns
`status: ACTIVE, isAcceptingPayments: true`, and `sandboxOnlyActivateFirm` refuses with *"firm is
already active"*. `mockOnboarding` does what the docs say — the mutation's own payload is just
written before activation lands. **If we persist `confido_firm_status` from the createFirm
response we will store a status the firm has already left**, and an org will look un-onboarded
when it is ready to trade. Always re-query, or wait for the `firm.updated` webhook.

**B. `sandboxOnlyFillOnboardingData` is broken on a fresh firm.** It answers *"OnboardingData not
found"* on a `CREATED` firm, while `sandboxOnlySubmitOnboardingData` — which the docs say calls
Fill under the hood — works fine from the same state. The rest of the ladder
(`APP_SUBMITTED → APP_IN_REVIEW → ACTIVE`) behaves as documented. Only affects sandbox tooling.

### Still open — needs a browser, not a script

**Partial-payment allocation (the one question the script cannot answer).** Because
`recordManualPaymentOnPaymentLink` *requires* an explicit allocation, the manual path only ever
returns the split we asked for. How Confido allocates when a **real payer** part-pays a hosted
split link is still unknown, and it's the one behaviour our trust-first policy has to agree with.
The spike prints a ready-made link for this:

```
pay $200 of $2,000 at the paylink URL in the findings block, then re-query the link balance
```

**ACH lifecycle and `transaction.ach_returned`** are also uncovered: manual payments land
`DEPOSITED` immediately, so there is no settlement to simulate, and `sandboxOnlyTriggerAchReturn`
needs a transaction of `type: achPayment` — i.e. a real ACH payment through the hosted link. This
matters because an ACH return claws back money we have already booked (Flag 2).

---

## Phase 0 — Prerequisites (already satisfied)

Done — a sandbox Partner account and token are in place. Retained for the production cutover:

1. Email **support@confidolegal.com** to get a **Partner account** — there is no self-serve path.
2. Sign up separately at **app.sandbox.confidolegal.com** (sandbox is a wholly separate account
   from production).
3. From the sandbox Partner Portal → Settings, generate a **Partner Token**
   (`p_secret_sandbox_…`) and note the **webhook secret**.

Endpoints: sandbox GraphQL `https://api.sandbox.gravity-legal.com/v2`, production
`https://api.gravity-legal.com/`.

---

## Phase 1 — The spike

Add one script to the existing check harness (`scripts/check.ts` +
`scripts/checks/`, run via `npm run check <name>`), which already isolates onto the test
database and is the established place for standalone inspection scripts:

**`oravanti-backend/scripts/checks/14-confido-sandbox.ts`**

Numbered 14 to avoid colliding with `13-notifications` on the notifications branch. Follows the
existing `PASS`/`FAIL`-per-assertion, non-zero-exit convention documented in
`scripts/checks/README.md`. It talks only to Confido's sandbox over `axios` (already a
dependency — no GraphQL client needed for a spike) and touches **no** application tables.

New env vars, optional, alongside the `STRIPE_*` block in `src/config/env.ts`:
`CONFIDO_PARTNER_TOKEN`, `CONFIDO_API_URL`, `CONFIDO_WEBHOOK_SECRET`.

### What it does

1. `createFirm(input: { name, mockOnboarding: true })` — sandbox-only shortcut that lands the
   firm straight in `ACTIVE` with one default operating and one default trust bank account.
   Capture `apiToken` and `onboardingToken { token expiresAt }` (assert the 24h TTL, since our
   re-mint endpoint depends on it). Also exercise standalone `createOnboardingToken` with a firm
   token, which is the call the embedded flow will actually use.
2. Separately, `createFirm` **without** `mockOnboarding`, then walk the real status ladder via
   `sandboxOnlyFillOnboardingData` → `sandboxOnlySubmitOnboardingData` →
   `sandboxOnlySendFirmToReview` → `sandboxOnlyActivateFirm`, asserting the
   `CREATED → APP_IN_DRAFT → APP_SUBMITTED → APP_IN_REVIEW → ACTIVE` transitions.
3. `bankAccountsList(firmId)` — assert exactly one `category: 'operating'` and one
   `category: 'trust'`, both `isDefault: true`; record their ids.
4. `addClient` and `matterCreate` using our lead/client uuid as `externalId`; assert
   `client(externalId:)` round-trips.
5. **The core assertion.** `addPaymentLink` with an explicit split mirroring a real
   fee-agreement invoice — e.g. `trust: 50000` (filing fee) + `operating: 150000` (attorney
   fee) — then the same again via `amounts: [{ amount, bankAccountId }, …]`. Assert
   `PaymentLink.amounts` resolves to the right two bank accounts and `balance` reports
   `trustOutstanding` / `operatingOutstanding` correctly.
6. `recordManualPaymentOnPaymentLink` (full amount) → assert **how many `Transaction` rows**
   result, what `bankAccount` and `amountProcessed` each carries, and whether they share a
   `txnGroupId`.
7. **Partial payment** — the highest-value unknown. Create a split link with
   `partialPaymentAllowed: true`, pay part of it, and observe which account Confido credits.
8. Drive `sandboxOnlyMoveTransactionToFundsInTransit` → `…ToDeposited`, then
   `sandboxOnlyTriggerAchReturn` and `transactionRefund`, capturing the resulting transaction
   shapes.
9. Print a machine-readable summary of every observed payload for the Phase-2 design.

### The open questions — status after the run

None of these are documented; each changes our schema design. See **Spike Results** above for the
measured answers.

| # | Question | Status |
|---|---|---|
| 1 | Partial-payment allocation on a hosted link | **ANSWERED — trust first**, matching our chosen policy. Verified twice: $200 by card, then $200 by ACH |
| 2 | Transactions per split payment | **ANSWERED — one per bank account actually credited.** `txnGroupId` is populated on real payments but `null` on API-recorded manual ones, so `Payment.id` is the reliable correlator |
| 3 | `PaymentStatus.partial_success` | **NOT OBSERVED** — a full split payment returned `success`. Whether one leg can fail alone is unproven; handle it defensively |
| 4 | Surcharge on trust | **ANSWERED** — `surchargeEnabled` defaulted to `false`, surcharge 0 on both legs. Set it explicitly anyway |
| 5 | Return URL | **ANSWERED — there is none.** The hosted page ends on a Confido confirmation screen with a "pay more" link. The payer is never sent back to us |
| 6 | ACH return against a split | **ANSWERED — only the returned leg unwinds**, via a separate positive `achReturn` row pointing at the original |

**All six are now answered.** Nothing that gates the Phase 2 schema design is still guesswork.

### No return URL — the one answer that changes a decision

Confirmed in the browser: after paying, the hosted page shows a Confido confirmation screen with a
link to pay more. There is no redirect back to us, and `AddPaymentLinkInput` has no field to
request one. Three consequences:

1. **`CheckoutInput.returnUrl` is meaningless for Confido** and should come off the interface. The
   stub's `${returnUrl}?demo=1` behaviour has no analogue.
2. **Webhooks are the only completion signal.** There is no "payer came back" moment to refresh
   state on. Architecturally that is correct — the webhook should be authoritative anyway — but it
   means the client's payment and our knowledge of it are decoupled in time, and our UI must be
   built for that rather than assuming a synchronous return.
3. **A redirect leaves the client stranded on Confido's page.** Their last impression of the
   transaction is someone else's confirmation screen, and they have no route back into the portal.

Two mitigations, and they compose:

- **Brand the hosted page per firm.** `firmBrandingUpdate(firmId, input)` takes `headerImg`,
  `headerName`, `backgroundColor`, `centerColor` and `footerText`; `FirmSettings.brandingPageUrl`
  points at the same thing in Confido's UI. Worth calling at onboarding so the page a client lands
  on carries the firm's identity, not Confido's.
  **`headerImg` is not a URL.** It is `{ s3Key, filename, contentType }`, and the bytes go to
  Confido first: `firmBrandingHeaderImgUploadUrl(firmId, filename, contentType)` returns
  `{ s3Key, uploadUrl }`, you PUT the image there, then reference the key. They ingest into their
  own storage, so nothing of ours is hot-linked and there is no expiring-URL problem to design
  around — which matters because our own R2 download URLs last one hour and SigV4 caps them at
  seven days regardless.
- **Embed rather than redirect.** Confido supports putting a Payment Link in an iframe — same link,
  same PCI posture, same automatic access to future payment methods. The client stays on our
  `/invoice-payment/:token` page, we keep our chrome around it, and we can poll our own endpoint so
  the page flips to "paid" when the webhook lands. **Decided: iframe embed.** But see the CSP
  caveat immediately below — it is a launch blocker if not handled.

#### ⚠️ The iframe is not currently permitted by their CSP

The hosted payment page returns:

```
content-security-policy-report-only:
  … frame-ancestors https://*.confidolegal.com https://pay.sandbox.confidolegal.com; …
```

**Our domain is not in `frame-ancestors`.** The only reason an iframe embed works today is that
the header is `report-only` — advisory, not enforced. Report-only is precisely what a team ships
while preparing to enforce, so this should be treated as temporary.

Two things follow, and neither can be settled from sandbox:

1. **Registering our domain in Trusted Domains is almost certainly the mechanism** that adds it to
   `frame-ancestors`. That setting is documented under hosted-fields, and **sandbox does not
   enforce domain restrictions at all** — so the spike cannot prove it either way (Flag 14).
2. **Confirm with support@confidolegal.com** that (a) Trusted Domains feeds `frame-ancestors` for
   `pay.confidolegal.com`, and (b) whether production already enforces the policy rather than
   reporting it.

If the answer is no, the iframe is not available and we fall back to the redirect plus branding.
Worth asking before any frontend work starts, because it decides which of the two we build.

---

## What fits well

- **`amounts: [AddAmountInput!]`** on `addPaymentLink` maps almost exactly onto our existing
  `invoice_payments.amount_operating` / `amount_trust` columns and their
  `amount_operating + amount_trust = amount` check constraint.
- **Confirmed by the spike:** because Confido emits one transaction per bank account, the natural
  mapping is **one `invoice_payments` row per leg**, single-sided (`amount_trust = amount`,
  `amount_operating = 0` or vice versa). The existing
  `amount_operating + amount_trust = amount` check permits that unchanged, and it means we record
  what the processor actually did instead of re-deriving a split. Key each row on the leg's own
  transaction id.
- `recordPayment()` in `src/modules/finance/payments.service.ts` **already accepts an explicit
  `amountOperating`/`amountTrust` split** (bypassing `proRateSplit`), so the webhook path can
  pass Confido's actual per-account figures rather than re-deriving them. No change needed.
- `Client` / `Matter` both carry `externalId` with dedicated lookup queries — our uuids can be
  the join key, no mapping table needed.
- Webhook idempotency: Confido's `eventId` is stable across resends, which is exactly what
  `payment_webhook_events` was built for.
- `Firm` is one-per-legal-entity, matching our `organization` row 1:1. Confido's own guidance:
  *"map one legal entity in your product to one Confido Firm — not one Confido Firm per attorney."*

---

## Flags — things that don't fit, worst first

**1. Saved cards and subscriptions cannot split trust/operating.**
`SPMPaymentInput.amount` is a singular `AddAmountInput`; `AddSubscriptionInput` says outright
*"Subscriptions can only have a single bank account."* Our fee-agreement invoices routinely carry
both (see `linesFromDocument` in `fee-agreement-billing.service.ts:63`, which routes
`kind === "government"` to `trust_iolta` and everything else to `operating`). Auto-charging a
card on file for such an invoice needs **two separate charges** → two transactions, two
surcharges, two receipts. Instalment plans that span both accounts hit this on every instalment.

**2. Refunds and ACH returns have nowhere to go in our schema.**
`invoice_payments` has `check(amount > 0)` and is insert-only. Confido has full
void/refund/ACH-return/chargeback support, and `transaction.ach_returned` means **money we
already recorded as received can be clawed back**. There is no refund, chargeback or dispute
concept anywhere in our schema or code. Not optional — ACH is the natural method for trust
deposits and ACH returns are routine.

**Now measured, and the fix is smaller than feared.** Confido models a return as a *separate
transaction with a positive amount* pointing back at the original, and flips the original to
`RETURNED`. So `check(amount > 0)` **stays**; what we add is a `kind` column
(`payment | refund | return | void | chargeback`) and a self-reference to the reversed row. The
one trap: the reversing row is positive, so `recalculateInvoiceTotals` must exclude or sign it, or
a returned payment reads as two payments.
**Spike detail:** refunding one leg of a split refunds *only* that leg (`originalTransactions:
["operating"]`, trust untouched), so whichever shape we choose must be **per-leg**, not
per-payment. Refunds returned `SUCCESS` synchronously here, but the documented
`AWAITING_RESULT` path still has to be handled.

**Related, and newly confirmed: the case-opening gate fires on unsettled money.** A real card
payment sits at `PENDING` with `canVoid: true, canRefund: false, settledOn: null` — it has not
settled and can still be pulled from the batch. But `feeInvoiceSatisfied`
(`fee-agreement-billing.service.ts:232`) only asks whether anything has been *received*, so a
case opens the moment the payment lands. With ACH that window is days long and ends in a possible
return. The gate should require `DEPOSITED`, not merely "something arrived".

**3. The webhook seam's shape is wrong in three ways.**
   - `parseEvent(rawBody): PaymentEvent | null` returns **one** event, but Confido POSTs a
     **JSON array** of payloads per request. Must become `parseEvents(): PaymentEvent[]`.
   - Confido webhooks are **thin** — `transaction.created` delivers only `transaction.id`. The
     handler must query the API back for amount and bank account, so `parseEvent` cannot stay a
     pure synchronous function.
   - `PaymentEvent` has no account dimension; it needs `operating`/`trust` amounts, not one
     `amountCents`.
   Also: header is `X-SIGNATURE` (HMAC-**SHA512**, base64), not `stripe-signature` —
   `payments-public.routes.ts:84` reads the latter.

**4. `isPaymentProviderConfigured()` is global; Confido is per-firm.**
It currently returns one boolean from `env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET`.
With Confido, every organization has its **own** firm API token and its own `FirmStatus` — an
org mid-underwriting genuinely cannot take payments while its neighbour can. This must become
per-org, and `CheckoutInput` (which threads `organizationId` but has nowhere to put an account)
needs the firm credential.

**5. `organization` has no payment-processor columns at all.**
No account id, no status, no onboarding state. We need `confido_firm_id`,
`confido_firm_status`, and an **encrypted** firm API token. Note the token's properties: no TTL,
no refresh endpoint, **not scoped** (any firm token can do anything the firm can), and revocation
is portal-only with no webhook. Storing a long-lived unscoped full-access credential per tenant
deserves the same treatment as `contractor_payment_details` — field encryption under
`PAYMENT_ENCRYPTION_KEY`.

**6. Webhooks are Partner-level, not firm-level.**
One URL receives events for every firm, with `firmId` in the payload. Our handler resolves the
org from the invoice (`payment-webhooks.service.ts:66`). We need a `confido_firm_id →
organization_id` index, and it must be exact — this endpoint is unauthenticated and runs with
`systemDb`, i.e. **outside RLS**. A wrong mapping here is a cross-tenant financial write.

**7. Confido's 5-second webhook timeout vs. our inline handler.**
Non-2xx within 5s marks the event failed; repeated failures over 24h **disable the webhook URL**
entirely, portal-only to re-enable. Our handler does signature check, event claim, invoice
lookup, `recordPayment`, totals recalculation, finance-event and case-event logging — all inline,
in one transaction. Should ack immediately and hand off to BullMQ, which we already run.

**8. `firm_status` has values the docs' timeline omits.**
The introspected `FirmStatus` enum is `CREATED, APP_IN_DRAFT, APP_SUBMITTED, APP_IN_REVIEW,
ACTIVE, DECLINED, INACTIVE, SUSPENDED`. The onboarding page documents only the first five plus
`INACTIVE`. `DECLINED` (added Jan 2026) is **terminal** — a firm that fails underwriting cannot
retry without contacting support. `SUSPENDED` is undocumented entirely. Our state machine must
handle all eight, and the UI needs an honest story for a declined firm.

**9. Money representation: `numeric(15,4)` vs. integer cents.**
Ours is `numeric(15,4)` throughout finance (deliberately — the extra scale carries rate precision).
Confido is `Int` cents everywhere. `money.ts` already isolates conversion and `amountCents`
appears at exactly two call sites, so this is contained — but every split leg must round
independently and still sum to the total, or the `amount_operating + amount_trust = amount`
check will fire.

**10. Account category naming and typing.**
Our enum is `account_type = ('operating', 'trust_iolta')`; Confido's `BankAccount.category` is a
plain **`String!`** (not an enum) holding `'operating'` or `'trust'`. Needs a mapping layer, and
the untyped field means a typo won't be caught by the schema.

**11. Consultation invoices are billed to a *lead*, not a client.**
`consultation-billing.service.ts` raises the invoice against `leadId`, and `invoices` has
`check(clientId IS NOT NULL <> leadId IS NOT NULL)`. Confido's `addPaymentLink` **requires**
`clientId`. So we must create a Confido `Client` for a lead that has no client row on our side —
and reconcile when that lead later converts and gets a real `clients` row.

**12. Pre-existing inconsistency worth fixing while we're here.**
`fee_agreements.details.accountSplit { operating, trust }` is set by the wizard and printed on
the PDF, but the invoice's actual account routing is derived independently from line `kind` in
`linesFromDocument`. The two can disagree. Likewise `paymentAllocation.order`
(`fees_first`/`costs_first`/`custom`) is rendered into the signed agreement by
`fee-agreement-pdf.ts:71` but **never applied** — `recordPayment` always pro-rates. We are
telling clients in a signed document how their money will be allocated and then doing something
else. The trust-first decision above should be implemented in `proRateSplit`'s place, and the
`accountSplit`/`kind` disagreement resolved.

**13. Rate limits are low for backfills.**
500 req/min and **10 concurrent** per firm or partner. Fine for normal traffic; a migration or
bulk firm creation needs throttling and exponential backoff on `429`. Relevant here because
Confido suggests pre-creating a Firm for every account in one bulk operation.

**14. Trusted Domains are a production-only trap.**
Any page loading a Confido JS SDK must have its domain registered in the Partner Portal under
Settings → Trusted Domains (wildcards allowed, `https` required off localhost, takes minutes to
propagate). **Sandbox does not enforce this** — so the embedded onboarding form will work
perfectly in the spike and then fail to load on the first production deploy unless the domain is
registered ahead of time. Documented under hosted-fields; confirm during the spike that it applies
to `onboarding.js` as well, and add it to the cutover checklist either way.

**15. Their HMAC example re-serialises.**
Confido's sample does `JSON.stringify(webhookPayload)` on the *parsed* body. That's fragile —
key order and whitespace won't reliably reproduce the signed bytes. We should HMAC the **raw
buffer**, which our seam already correctly plumbs through (`app.ts:91` mounts
`express.raw` on `/webhooks/payments` before `express.json()`), and confirm during the spike that
raw-buffer verification actually matches their signature.

---

## Verification

The spike is self-verifying — `npm run check 14-confido-sandbox` prints `PASS`/`FAIL` per
assertion and exits non-zero on failure, matching the existing checks. Beyond that:

- `npm run typecheck` for the new script and env vars.
- Drop `https://js.sandbox.gravity-legal.com/onboarding.js` onto a scratch HTML page with a real
  onboarding token and call `renderForm` — this is the one part the check script cannot cover, and
  it's what tells us how much of the form we can actually restyle before committing to the
  embedded flow in the UI.
- Point a webhook URL at a tunnel, trigger a sandbox payment, and confirm HMAC-SHA512 over the
  raw buffer matches `X-SIGNATURE`.
- Test cards and ACH numbers are at `docs.confidolegal.com/docs/sandbox/test-payment-methods`.

Per this repo's constraints I won't run the jest suite, and I'll leave `tsc`/builds to you if the
machine is loaded.

## Out of scope for this spike

Production credentials and cutover; schema migrations; the `PaymentProvider` implementation;
onboarding and payment UI; refund/ACH-return modelling; disbursements (Confido supports paying
settlements out, which we don't model at all). All of these get planned once the spike's six open
questions are answered.
