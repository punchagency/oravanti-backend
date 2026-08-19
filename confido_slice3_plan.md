# Confido Legal — Phase 2, Slice 3: money going back out

## Context

Slices 1 and 2 get money in: a firm onboards, a client pays an embedded payment link, and Confido's
`transaction.*` webhooks write one single-sided `invoice_payments` row per credited account.

Slice 3 handles the other direction. Four things claw money back, and today all four are invisible:

|                | What it is                                                               | Who starts it |
| -------------- | ------------------------------------------------------------------------ | ------------- |
| **Void**       | An unsettled payment pulled from the batch before it deposits            | The firm      |
| **Refund**     | Settled money sent back, whole or in part                                | The firm      |
| **ACH return** | The client's bank rejecting a debit — R01 insufficient funds and friends | The bank      |
| **Chargeback** | The client disputing a card payment with their issuer                    | The client    |

Plus the gate the spike flagged: `feeInvoiceSatisfied` opens a case on money that has merely
_arrived_, not settled — and with ACH the window between the two is days long and ends in a
possible return.

### Decisions taken before building

|                          |                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| **Case-opening gate**    | A **firm-level setting, defaulting to ACH-only.** Cards open a case at once; ACH must clear         |
| **Refund authorization** | **Owner/admin only**, via a new `finance: ["refund"]` permission, **plus** the existing trust rules |
| **Scope**                | Backend and frontend, as slices 1 and 2 shipped                                                     |

---

## The ledger model: signed amounts

The spike concluded "a `kind` column, not a signed ledger", and for **ingest** that was right —
Confido models a return as a separate transaction with a _positive_ amount pointing back at the
original, so nothing forces us to invent negatives at the boundary. But the conclusion does not
carry to the **fold**, and that is where the decision bites.

`invoice_payments` has five consumers, four of which sum money:

|                                           | Reads                                         | Must it net reversals?                                      |
| ----------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `totals.ts`                               | `sum(amount)` → `invoices.amount_paid`        | **Yes**                                                     |
| `payments.service.sumPaidBySide`          | `sum(amount_operating/trust)`                 | **Yes** — drives the trust-first split for the next payment |
| `payment-links.service.outstandingBySide` | same                                          | **Yes** — decides what we ask Confido for                   |
| `reports.service`                         | `sum(amount_trust)` — "filing fees collected" | **Yes**                                                     |
| `invoices.service`                        | lists the rows                                | No — it should show reversals as rows                       |

So the question is what happens when someone adds a sixth consumer and forgets the rule.

- **Positive amounts + `kind`:** a forgotten filter makes a refunded invoice read as having been
  paid _twice over_. The reversal adds to the total it was supposed to subtract from. Wrong
  direction, wrong magnitude, and it reads as "more paid" — the direction nobody investigates.
- **Signed amounts:** a forgotten filter yields the **net** figure, which is the correct answer
  almost everywhere. Getting gross collections requires opting in.

Signed wins on the failure mode. `round()` in `money.ts` already handles negative money explicitly
("Money can be negative (a credit)"), so the helpers were built for this.

`invoice_payments_split_balances` (`amount_operating + amount_trust = amount`) holds unchanged with
negatives. `invoice_payments_amount_positive` is replaced by a constraint tying sign to kind:

```sql
check (case when kind = 'payment' then amount > 0 else amount < 0 end)
```

Enumerating rather than writing `amount <> 0` is deliberate. A future positive non-payment — a
chargeback _reversal_, when the firm wins the dispute — cannot be added without editing this
constraint, which puts the sign question in front of whoever writes that migration.

### New columns on `invoice_payments`

| Column                |                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                | `payment \| refund \| return \| void \| chargeback \| reversal`. Defaults to `payment`, which backfills every existing row correctly |
| `reverses_payment_id` | Self-reference to the row being undone. Null on payments                                                                             |
| `settled_at`          | When the money actually landed. Null while in flight                                                                                 |
| `provider_status`     | Confido's `status_v2` verbatim — so `HELD` is distinguishable from `PENDING`                                                         |

`reversal` is a catch-all. We classify from the webhook event type, a closed documented set, but a
reversal we cannot name is still money that moved, and dropping it is worse than recording it
imprecisely.

Who fills `settled_at`:

- **Staff-entered payments** — set at insert. A cheque recorded by hand is a staff member asserting
  the money is in the firm's hands; no webhook is coming.
- **Provider payments** — null at insert, filled by `transaction.deposited`.
- **Reversals** — set at insert. Deliberately asymmetric: money leaving counts against the firm at
  once, money arriving counts only once it has cleared.

`amount_paid` is net of reversals but **gross of settlement**. A client who has paid is paid,
whether or not the funds have cleared — settlement is the firm's cashflow question, not the client's
obligation. Only the case-opening gate asks about settlement, and it asks explicitly.

---

## The webhook payloads are not the shape we assumed

`transactionIdOf` reads `data.transaction.id`. Correct for `transaction.created` and the two
settlement events, and **wrong for all four reversal events**, which use different keys:

| Event                                          | Payload keys                                     |
| ---------------------------------------------- | ------------------------------------------------ |
| `transaction.created`                          | `transaction.id`                                 |
| `transaction.funds_in_transit` / `.deposited`  | `transaction.id`                                 |
| `transaction.voided`                           | `originalTransaction.id`, `voidTransaction.id`   |
| `transaction.refunded` / `.partially_refunded` | `originalTransaction.id`, `refundTransaction.id` |
| `transaction.ach_returned`                     | `originalTransaction.id`, `returnTransaction.id` |

Left as-is these extract `null`, get enqueued, and do nothing — silently, since the handler already
tolerates a missing id. Extraction becomes shape-aware and the job carries both ids.

That the payload hands us the original's id is a gift: linking a reversal to the row it reverses
needs no extra API call.

### Chargebacks have no webhook

`TransactionStatus2.CHARGED_BACK` exists and `sandboxOnlyTriggerChargeback` exists, but there is **no
`transaction.charged_back` event** in the documented set. So a chargeback — money leaving the firm's
account with no action by the firm — reaches us only if `transaction.created` fires for the
chargeback transaction. `19-confido-reversals` settles that empirically.

Handling is therefore **structural rather than name-based**: any transaction carrying
`originalTransactionId` is a reversal, whatever its `type` string. That survives Confido adding a
reversal type we have never seen. Statement ingestion from slice 2b is the backstop either way — a
chargeback shows up as a debit line even if no event announces it.

---

## Recording a reversal

Look up the original by `provider_reference = originalTransaction.id`; insert a negative row of the
matching kind pointing at it.

**If the original is not found, do not record.** A reversal we cannot tie to a payment we booked is
a reconciliation exception, not a ledger entry — subtracting money we never added drives
`amount_paid` negative and marks a paid invoice unpaid. Log it loudly and leave it for a human.

Amount comes from the reversal transaction's own `amountProcessed`, negated — not the original's,
because a partial refund is smaller than what it reverses. The side comes from the reversal's own
`bankAccount.category`: the spike confirmed refunding one leg of a split touches only that leg.

A reversal may not exceed what remains of the payment it reverses. The unique index catches a replay
of the _same_ reversal; this catches two distinct events describing one real refund.

---

## Initiating a refund

Confido offers three mutations:

- `transactionVoid` — no `amount` field; voids are always whole. Valid only before settlement.
- `transactionRefund` — takes `amount` in cents. Valid only after settlement.
- `transactionVoidOrRefund` — picks, and returns `type` saying which it did.

Choosing between the first two ourselves means reading `canVoid`/`canRefund` and then acting, and a
payment can settle in the gap. `transactionVoidOrRefund` makes that Confido's race to lose. So:
**full reversal goes through `transactionVoidOrRefund`; a partial amount goes through
`transactionRefund`**, the only one that can express one. The firm-facing verb is "refund" either
way; whether it executed as a void is reported back, not asked about.

**Recorded twice, on purpose.** The mutation returns its transactions synchronously; we record from
that response _and_ from the webhook, and let `invoice_payments_provider_ref_uidx` collapse the
duplicate. Webhook alone risks money moving that our ledger never learns about; response alone
misses the documented `AWAITING_RESULT` path.

**Authorization** is `finance: ["refund"]` — a new permission granted to owner and admin only, kept
separate from `record_payment` because recording a payment wrong is correctable and sending money to
a client is not. A trust-leg refund additionally requires `requireTrustWrite`, exactly as recording
trust money does.

---

## The case-opening gate

`feeInvoiceSatisfied` asks "nothing overdue, and something received". A real card payment sits at
`PENDING` with `canVoid: true, settledOn: null`, so a case opens on money that can still be pulled.

It becomes "nothing overdue, and enough money that **counts**", where counting is a firm-level
policy stored as `confido_firms.payment_clearing_policy`:

| Policy                 | Money counts when                                   |
| ---------------------- | --------------------------------------------------- |
| `on_report`            | Always — today's behaviour                          |
| `ach_only` _(default)_ | Unless it is unsettled **and** either ACH or `HELD` |
| `all_payments`         | Only once settled                                   |

`HELD` is excluded even under `ach_only`. It is Confido's high-dollar risk review — which a USCIS
filing fee is exactly the shape to trigger — and it means "we are not sure this money is good",
which is the one thing the gate should never wave through.

Manual staff entry is unaffected under every policy: those settle at insert. Reversals are negative
and always settled, so they reduce the counted total under every policy too.

---

## Work

**Backend**

1. Schema: the four columns, the sign constraint, the self-reference,
   `confido_firms.payment_clearing_policy`, the `finance.payment_reversed` audit action, and the
   `finance: ["refund"]` permission.
2. `recordPayment` gains `settledAt`/`providerStatus`; new `recordReversal` and `markPaymentSettled`.
3. Webhook: shape-aware id extraction, the four reversal events, the reversal path, and
   `transaction.deposited` advancing settlement instead of being a no-op.
4. Client: `voidOrRefundTransaction`, `refundTransaction`.
5. Refund endpoint, `finance:refund` + trust-gated.
6. `feeInvoiceSatisfied` on counted money; policy read/write on the Payments settings module.
7. `19-confido-reversals` — void, refund, partial refund, ACH return and chargeback against the
   sandbox, recording which `type` string each produces and whether a chargeback emits anything.

**Frontend**

8. The payment list shows kind, settlement state, and what a reversal reverses.
9. A refund action on a payment, with an amount for partials, visible only with the permission.
10. The clearing policy on the Payments settings tab.

## Verification

`npm run typecheck` and `npm run lint` both repos, `npm run check 12-finance`, and the new
`19-confido-reversals`. I will not run the backend jest suite.
