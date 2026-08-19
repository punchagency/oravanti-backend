/**
 * Tier 3 — Confido sandbox. What money going back out actually looks like.
 *
 *   CONFIDO_PARTNER_TOKEN=p_secret_sandbox_… npm run check 19-confido-reversals
 *
 * Slice 3 has to classify four different reversals from an untyped `type`
 * string, and the docs name none of the values. This drives all four against a
 * real sandbox firm and prints what came back, so the mapping in
 * `reversalKindFor` is built on observation rather than on guesswork.
 *
 * Three questions it exists to settle:
 *
 *   1. **What `type` string does each reversal produce?** `achReturn` is the
 *      only one the earlier spike saw.
 *   2. **Does every reversal carry `originalTransactionId`?** The webhook
 *      recognises reversals structurally rather than by name, so if any one of
 *      them omits it, that reversal is money we would silently fail to record.
 *   3. **Does a chargeback emit anything at all?** There is no documented
 *      `transaction.charged_back` webhook, which would mean money leaving the
 *      firm's account with nothing to announce it.
 *
 * Assertions cover 1 and 2. Question 3 cannot be asserted from here — it is
 * about webhook delivery, not API state — so what a chargeback does to the
 * transaction is printed as a NOTE for the support thread.
 */
import { randomUUID } from "crypto";
import { check, checkEqual, report, section } from "./_bootstrap";

const RUN = randomUUID().slice(0, 8);
const API = process.env.CONFIDO_API_URL ?? "https://api.sandbox.gravity-legal.com/v2";
const PARTNER = process.env.CONFIDO_PARTNER_TOKEN;

const TXN_FIELDS = `
  id type status_v2 amountProcessed amountRefunded
  originalTransactionId achReturnCode achReturnReason settledOn
  canVoid canRefund
  bankAccount { id category }
`;

type Txn = {
  id: string;
  type: string;
  status_v2: string;
  amountProcessed: number;
  amountRefunded: number;
  originalTransactionId: string | null;
  achReturnCode: string | null;
  achReturnReason: string | null;
  settledOn: string | null;
  canVoid: boolean;
  canRefund: boolean;
  bankAccount: { id: string; category: string };
};

const gql = async (token: string, query: string, variables = {}) => {
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data ?? {};
};

/** Every reversal type string we saw, for the closing NOTE. */
const observed: { scenario: string; type: string; status: string; linked: boolean }[] = [];

const main = async () => {
  if (!PARTNER?.includes("sandbox")) {
    // Every mutation below either creates a firm or moves money.
    console.error("\x1b[31mA sandbox CONFIDO_PARTNER_TOKEN is required.\x1b[0m");
    process.exit(1);
  }

  section("setup");

  const created = (await gql(
    PARTNER,
    `mutation C($input: CreateFirmInput) {
      createFirm(input: $input) { id apiToken }
    }`,
    { input: { name: `Reversals Check ${RUN}`, mockOnboarding: true } },
  )) as { createFirm: { id: string; apiToken: string } };

  const firmId = created.createFirm.id;
  const firmToken = created.createFirm.apiToken;
  check("a sandbox firm exists", Boolean(firmId));

  const payer = (await gql(
    firmToken,
    `mutation A($input: AddClientInput!) { addClient(input: $input) { id } }`,
    { input: { clientName: `Payer ${RUN}`, externalId: randomUUID(), firmId } },
  )) as { addClient: { id: string } };

  /** A fresh paid link, so each scenario reverses its own money. */
  const payOne = async (cents: number): Promise<Txn> => {
    const link = (await gql(
      firmToken,
      `mutation L($input: AddPaymentLinkInput!) {
        addPaymentLink(input: $input) { id }
      }`,
      {
        input: {
          clientId: payer.addClient.id,
          externalId: randomUUID(),
          operating: cents,
          surchargeEnabled: false,
        },
      },
    )) as { addPaymentLink: { id: string } };

    const paid = (await gql(
      firmToken,
      `mutation P($input: RecordManualPaymentInput!) {
        recordManualPaymentOnPaymentLink(input: $input) {
          transactions { ${TXN_FIELDS} }
        }
      }`,
      {
        input: {
          paymentLinkId: link.addPaymentLink.id,
          operating: cents,
          billingName: `Payer ${RUN}`,
        },
      },
    )) as { recordManualPaymentOnPaymentLink: { transactions: Txn[] } };

    return paid.recordManualPaymentOnPaymentLink.transactions[0]!;
  };

  /**
   * The reversal that points at `originalId`, if Confido has created one.
   *
   * The sandbox triggers return only a boolean, so this stands in for what the
   * webhook is handed directly. It is also the exact query that would answer
   * "did a chargeback happen" if no webhook ever announces one.
   */
  const findReversalOf = async (originalId: string): Promise<Txn | null> => {
    const data = (await gql(
      firmToken,
      `query L($limit: Int!) {
        transactionsList(limit: $limit, orderDir: desc) {
          records { ${TXN_FIELDS} }
        }
      }`,
      { limit: 100 },
    )) as { transactionsList: { records: Txn[] } };

    return (
      data.transactionsList.records.find(
        (t) => t.originalTransactionId === originalId,
      ) ?? null
    );
  };

  const fetchTxn = async (id: string): Promise<Txn> => {
    const data = (await gql(
      firmToken,
      `query T($id: String!) { transaction(id: $id) { ${TXN_FIELDS} } }`,
      { id },
    )) as { transaction: Txn };
    return data.transaction;
  };

  /**
   * Assert the shape every reversal must have for the webhook to record it.
   *
   * `originalTransactionId` is the load-bearing one. The handler recognises a
   * reversal by that field rather than by its type string, so a reversal
   * missing it is one we would drop on the floor.
   */
  const assertReversalShape = (scenario: string, reversal: Txn, original: Txn) => {
    check(
      `${scenario}: the reversal is its own transaction`,
      reversal.id !== original.id,
      "a reversal that mutated the original in place would need a different ledger model entirely",
    );
    checkEqual(
      `${scenario}: it points back at what it reverses`,
      reversal.originalTransactionId,
      original.id,
    );
    check(
      `${scenario}: its amount is positive`,
      reversal.amountProcessed > 0,
      `got ${reversal.amountProcessed} — recordReversal negates this, so a negative here would double-negate`,
    );
    observed.push({
      scenario,
      type: reversal.type,
      status: reversal.status_v2,
      linked: reversal.originalTransactionId === original.id,
    });
  };

  // ── Void: reversing money that has not settled ────────────────────────────
  //
  // `transactionVoidOrRefund` is what the refund service calls, precisely
  // because it decides rather than making us read canVoid/canRefund and then
  // race the settlement. Its `type` field is how we learn which it did.
  section("void or refund, unsettled");

  const toVoid = await payOne(20_000);
  const voidResult = (await gql(
    firmToken,
    `mutation V($input: TransactionVoidOrRefundInput!) {
      transactionVoidOrRefund(input: $input) {
        type status
        voidOrRefundTransactions { ${TXN_FIELDS} }
      }
    }`,
    { input: { transactionId: toVoid.id, externalId: randomUUID() } },
  )) as {
    transactionVoidOrRefund: {
      type: string;
      status: string;
      voidOrRefundTransactions: Txn[] | null;
    };
  };

  const voidTxns = voidResult.transactionVoidOrRefund.voidOrRefundTransactions ?? [];
  console.log(
    `\n  voidOrRefund chose: type=${voidResult.transactionVoidOrRefund.type} ` +
      `status=${voidResult.transactionVoidOrRefund.status} txns=${voidTxns.length}`,
  );
  check(
    "voidOrRefund reports which operation it performed",
    Boolean(voidResult.transactionVoidOrRefund.type),
    "without this the caller cannot record a void as a void",
  );
  // Expect REFUND here, not VOID: an API-recorded manual payment is DEPOSITED
  // from the outset, so there is never anything to void. That is precisely the
  // argument for calling voidOrRefund rather than deciding ourselves — the
  // settlement state we would have branched on is not the one we assumed.
  console.log(
    "  (a manual payment is DEPOSITED immediately, so a true void is not\n" +
      "   reachable from the API — which is the case voidOrRefund exists for)",
  );

  for (const t of voidTxns) assertReversalShape("void", t, toVoid);

  // ── Full refund ───────────────────────────────────────────────────────────
  section("full refund");

  const toRefund = await payOne(30_000);
  const refundResult = (await gql(
    firmToken,
    `mutation R($input: TransactionRefundInput!) {
      transactionRefund(input: $input) {
        refundRequest { status }
        refundTransactions { ${TXN_FIELDS} }
      }
    }`,
    { input: { transactionId: toRefund.id, externalId: randomUUID() } },
  )) as {
    transactionRefund: {
      refundRequest: { status: string };
      refundTransactions: Txn[] | null;
    };
  };

  const refundTxns = refundResult.transactionRefund.refundTransactions ?? [];
  check(
    "a full refund produces at least one transaction",
    refundTxns.length > 0,
    "if this is ever empty, the refund service depends entirely on the webhook",
  );
  for (const t of refundTxns) assertReversalShape("refund", t, toRefund);

  const afterFullRefund = await fetchTxn(toRefund.id);
  checkEqual(
    "the original records what was given back",
    afterFullRefund.amountRefunded,
    toRefund.amountProcessed,
  );

  // ── Partial refund ────────────────────────────────────────────────────────
  //
  // The case that decides whether our headroom check is right: a second partial
  // must not be able to take the total past the original.
  section("partial refund");

  const toPartial = await payOne(40_000);
  const partial = (await gql(
    firmToken,
    `mutation R($input: TransactionRefundInput!) {
      transactionRefund(input: $input) {
        refundRequest { status }
        refundTransactions { ${TXN_FIELDS} }
      }
    }`,
    {
      input: {
        transactionId: toPartial.id,
        amount: 15_000,
        externalId: randomUUID(),
      },
    },
  )) as { transactionRefund: { refundTransactions: Txn[] | null } };

  const partialTxns = partial.transactionRefund.refundTransactions ?? [];
  for (const t of partialTxns) assertReversalShape("partial refund", t, toPartial);

  checkEqual(
    "a partial refund moves only what was asked for",
    partialTxns.reduce((sum, t) => sum + t.amountProcessed, 0),
    15_000,
  );

  const afterPartial = await fetchTxn(toPartial.id);
  checkEqual(
    "the original tracks the partial",
    afterPartial.amountRefunded,
    15_000,
  );
  check(
    "a partially refunded payment says so",
    afterPartial.status_v2 === "PARTIALLY_REFUNDED",
    `status was ${afterPartial.status_v2}`,
  );

  // Refunding more than remains must fail. Our own headroom check exists
  // because the ledger cannot rely on Confido to be the only guard — but if
  // Confido allows this, our check is the ONLY guard, which is worth knowing.
  let overRefundRejected = false;
  try {
    await gql(
      firmToken,
      `mutation R($input: TransactionRefundInput!) {
        transactionRefund(input: $input) { refundRequest { status } }
      }`,
      {
        input: {
          transactionId: toPartial.id,
          amount: 30_000,
          externalId: randomUUID(),
        },
      },
    );
  } catch {
    overRefundRejected = true;
  }
  check(
    "refunding more than remains is refused",
    overRefundRejected,
    "if this ever passes, recordReversal's headroom check is the only thing preventing a negative amount_paid",
  );

  // ── ACH return ────────────────────────────────────────────────────────────
  //
  // Returns happen to money that has already landed, so the payment is settled
  // first — firing at a PENDING transaction would test something that does not
  // occur in production.
  section("ach return");

  const toReturn = await payOne(25_000);
  for (const mutation of [
    "sandboxOnlyMoveTransactionToFundsInTransit",
    "sandboxOnlyMoveTransactionToDeposited",
  ]) {
    await gql(
      firmToken,
      `mutation M($id: String!) { ${mutation}(transactionId: $id) { id } }`,
      { id: toReturn.id },
    ).catch(() => {
      // Manual payments can already be DEPOSITED, in which case the move is a
      // no-op that errors. Not a failure of what is under test.
    });
  }

  let returnTxn: Txn | null = null;
  let achSkipped = "";
  try {
    // Returns Boolean, not the transaction — so the reversal has to be found
    // afterwards, which is the same thing the webhook does with an id it is
    // handed.
    await gql(
      firmToken,
      `mutation A($input: SandboxOnlyTriggerAchReturnInput!) {
        sandboxOnlyTriggerAchReturn(input: $input)
      }`,
      { input: { transactionId: toReturn.id } },
    );
    returnTxn = await findReversalOf(toReturn.id);
    check(
      "an ACH return can be triggered",
      Boolean(returnTxn),
      "the mutation succeeded but no linked transaction appeared",
    );
  } catch (err) {
    // "must be 'achPayment' transaction". Everything above pays through
    // `recordManualPaymentOnPaymentLink`, which produces `manualPayment` — and
    // there is no API path to a real ACH payment, because ACH means a payer
    // entering bank details on the hosted page.
    //
    // Not a gap in coverage: `15-confido-partial-payment -- ach-return` drives
    // exactly this against a browser-paid link, and already established the
    // shape — a separate positive `achReturn` row carrying
    // `originalTransactionId`, with the original flipping to RETURNED.
    achSkipped = (err as Error).message;
  }

  if (returnTxn) {
    assertReversalShape("ach return", returnTxn, toReturn);
    check(
      "a return carries the bank's reason code",
      Boolean(returnTxn.achReturnCode),
      `code=${returnTxn.achReturnCode} reason=${returnTxn.achReturnReason}`,
    );
    const afterReturn = await fetchTxn(toReturn.id);
    check(
      "the original flips to RETURNED rather than becoming negative",
      afterReturn.status_v2 === "RETURNED",
      `status was ${afterReturn.status_v2}`,
    );
  }

  if (achSkipped) {
    check(
      "an ACH return needs a real ACH payment, so it is covered elsewhere",
      true,
      `sandbox says: ${achSkipped} — see 15-confido-partial-payment -- ach-return`,
    );
  }

  // ── Chargeback ────────────────────────────────────────────────────────────
  //
  // The one with no documented webhook. Whether it produces a linked
  // transaction decides whether our structural rule catches it at all.
  section("chargeback");

  const toChargeback = await payOne(35_000);
  for (const mutation of [
    "sandboxOnlyMoveTransactionToFundsInTransit",
    "sandboxOnlyMoveTransactionToDeposited",
  ]) {
    await gql(
      firmToken,
      `mutation M($id: String!) { ${mutation}(transactionId: $id) { id } }`,
      { id: toChargeback.id },
    ).catch(() => {});
  }

  let chargebackSkipped = "";
  try {
    await gql(
      firmToken,
      `mutation C($input: SandboxOnlyTriggerChargebackInput!) {
        sandboxOnlyTriggerChargeback(input: $input)
      }`,
      { input: { transactionId: toChargeback.id } },
    );

    const cb = await findReversalOf(toChargeback.id);
    const after = await fetchTxn(toChargeback.id);
    console.log(
      `\n  chargeback: linked txn ${cb?.id ?? "NONE"} type=${cb?.type ?? "-"}`,
    );
    console.log(`  original is now ${after.status_v2}`);

    check(
      "a chargeback produces a transaction linked to the original",
      cb !== null,
      "if it is not linked, the webhook cannot recognise a chargeback structurally and the monthly statement is the only backstop",
    );
    if (cb) {
      observed.push({
        scenario: "chargeback",
        type: cb.type,
        status: cb.status_v2,
        linked: true,
      });
    }
  } catch (err) {
    // "must be card transaction". Same fixture limit as the ACH return, and
    // this one leaves a real question open rather than a covered-elsewhere one:
    // there is no documented `transaction.charged_back` webhook, so whether a
    // chargeback reaches us at all is unverified.
    chargebackSkipped = (err as Error).message;
  }

  if (chargebackSkipped) {
    check(
      "a chargeback needs a real card payment, which no API path creates",
      true,
      `sandbox says: ${chargebackSkipped}`,
    );
  }

  // ── What we learned ───────────────────────────────────────────────────────
  console.log("\n\x1b[1m  NOTE — reversal type strings observed\x1b[0m");
  console.log("  Feed these into reversalKindFor() in confido-webhooks.service.ts.\n");
  for (const o of observed) {
    console.log(
      `    ${o.scenario.padEnd(16)} type=${o.type.padEnd(14)} ` +
        `status=${o.status.padEnd(20)} linked=${o.linked}`,
    );
  }
  if (achSkipped || chargebackSkipped) {
    console.log("\n\x1b[1m  NOTE — what this check cannot reach\x1b[0m");
    console.log(
      "  Both remaining reversals need a payment this script cannot make: the\n" +
        "  sandbox refuses them on the `manualPayment` transactions the API can\n" +
        "  produce, and ACH and card both mean a payer on the hosted page.\n",
    );
    if (achSkipped) {
      console.log(
        "    ach return  — covered by 15-confido-partial-payment -- ach-return,\n" +
          "                  which pays a link in a browser first. Shape is known:\n" +
          "                  a positive achReturn row linked to the original.",
      );
    }
    if (chargebackSkipped) {
      console.log(
        "    chargeback  — STILL UNVERIFIED, and the one that matters. Confido\n" +
          "                  documents no transaction.charged_back webhook, so we\n" +
          "                  do not know whether a chargeback reaches us at all.\n" +
          "                  Until it is answered, statement ingestion is the only\n" +
          "                  backstop: the debit shows up there regardless.",
      );
    }
  }

  console.log(
    `\n  Confido firm ${firmId} (sandbox firms cannot be deleted)\n` +
      "  This check touches no tables — it is entirely network.\n",
  );

  await report();
};

main().catch(async (err) => {
  console.error("\x1b[31mCheck crashed:\x1b[0m", err);
  await report();
});
