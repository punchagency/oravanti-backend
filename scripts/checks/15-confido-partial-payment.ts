/**
 * Tier 3 — Confido Legal sandbox. The one question a script cannot answer alone.
 *
 *   npm run check 15-confido-partial-payment -- create    # make a link, pay it in a browser
 *   npm run check 15-confido-partial-payment -- inspect   # see how Confido split the money
 *
 * `14-confido-sandbox` proved a payment link CAN carry a trust leg and an
 * operating leg. What it could not prove is how Confido allocates a **partial**
 * payment across those legs, because `recordManualPaymentOnPaymentLink` demands
 * an explicit allocation — so the API only ever hands back the split we asked
 * for. Only a real payer choosing their own amount on the hosted page can
 * answer it, and the answer decides whether our trust-first policy agrees with
 * the processor or silently contradicts it.
 *
 * So: `create` builds a deliberately lopsided link and prints its URL, you pay
 * part of it in a browser, and `inspect` reports which allocation rule Confido
 * actually used.
 *
 * State (including a firm API token) is written to `.confido-partial.json`,
 * which is gitignored. Delete it to start over.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import axios from "axios";
import { check, report, section } from "./_bootstrap";

const API_URL =
  process.env.CONFIDO_API_URL ?? "https://api.sandbox.gravity-legal.com/v2";
const PARTNER_TOKEN = process.env.CONFIDO_PARTNER_TOKEN;

const STATE_FILE = join(__dirname, "..", "..", ".confido-partial.json");

// Deliberately lopsided, and the suggested payment is smaller than the trust
// leg alone. That is what makes the three candidate rules produce visibly
// different answers rather than three numbers that happen to look alike.
const TRUST_CENTS = 50_000; // $500 — government filing fee, client money
const OPERATING_CENTS = 150_000; // $1,500 — attorney fee, earned
const TOTAL_CENTS = TRUST_CENTS + OPERATING_CENTS;
const SUGGESTED_CENTS = 20_000; // $200

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type State = {
  firmId: string;
  firmToken: string;
  clientId: string;
  linkId: string;
  url: string;
  trustCents: number;
  operatingCents: number;
  createdAt: string;
};

// ─── GraphQL ─────────────────────────────────────────────────────────────────

type GqlError = { message: string };

const gql = async <T = Record<string, unknown>>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ data: T | null; errors: GqlError[] }> => {
  try {
    const res = await axios.post(
      API_URL,
      { query, variables },
      {
        headers: { "x-api-key": token, "Content-Type": "application/json" },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );
    const body = res.data ?? {};
    return { data: (body.data as T) ?? null, errors: (body.errors as GqlError[]) ?? [] };
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    };
  }
};

const readState = (): State | null => {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return null;
  }
};

const writeState = (state: State) => {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // The file carries a firm API token: unscoped, long-lived, no rotation
  // endpoint. Owner-only at rest is the least we can do.
  chmodSync(STATE_FILE, 0o600);
};

const guardToken = (token: string | undefined): string => {
  if (!token) {
    console.error(
      "\x1b[31mCONFIDO_PARTNER_TOKEN is not set.\x1b[0m Add it to .env or pass it inline.",
    );
    process.exit(1);
  }
  if (!token.includes("sandbox")) {
    console.error(
      `\x1b[31mRefusing to run: "${token.slice(0, 18)}…" is not a sandbox token.\x1b[0m`,
    );
    process.exit(1);
  }
  return token;
};

// ─── create ──────────────────────────────────────────────────────────────────

const create = async (reuse: boolean) => {
  const partnerToken = guardToken(PARTNER_TOKEN);
  const existing = reuse ? readState() : null;

  section("Setting up");

  let firmId: string;
  let firmToken: string;

  if (existing) {
    ({ firmId, firmToken } = existing);
    console.log(`  Reusing firm ${firmId} from ${STATE_FILE}`);
  } else {
    const run = randomUUID().slice(0, 8);
    const created = await gql<{
      createFirm: { id: string; apiToken: string };
    }>(
      partnerToken,
      `mutation Create($input: CreateFirmInput) { createFirm(input: $input) { id apiToken } }`,
      { input: { name: `Partial Payment Probe ${run}`, mockOnboarding: true } },
    );
    if (created.errors.length || !created.data) {
      check("createFirm", false, created.errors.map((e) => e.message));
      return report();
    }
    firmId = created.data.createFirm.id;
    firmToken = created.data.createFirm.apiToken;
    console.log(`  Created firm ${firmId}`);
  }

  // `createFirm` reports a stale status, so confirm the firm is really ready
  // rather than trusting the mutation payload (see 14-confido-sandbox).
  const firmState = await gql<{ firm: { status: string; isAcceptingPayments: boolean } }>(
    firmToken,
    `query { firm { id status isAcceptingPayments } }`,
  );
  check(
    "firm is ACTIVE and accepting payments",
    firmState.data?.firm.status === "ACTIVE" &&
      firmState.data.firm.isAcceptingPayments === true,
    firmState.data?.firm ?? firmState.errors.map((e) => e.message),
  );

  const accounts = await gql<{
    bankAccountsList: {
      bankAccounts: Array<{ id: string; category: string; isDefault: boolean }>;
    };
  }>(
    firmToken,
    `query { bankAccountsList { bankAccounts { id category isDefault } } }`,
  );
  const list = accounts.data?.bankAccountsList.bankAccounts ?? [];
  check(
    "firm has default trust and operating accounts",
    list.some((a) => a.category === "trust" && a.isDefault) &&
      list.some((a) => a.category === "operating" && a.isDefault),
    list,
  );

  const clientId =
    existing?.clientId ??
    (await (async () => {
      const run = randomUUID().slice(0, 8);
      const res = await gql<{ addClient: { id: string } }>(
        firmToken,
        `mutation Add($input: AddClientInput!) { addClient(input: $input) { id } }`,
        {
          input: {
            clientName: `Partial Probe Client ${run}`,
            email: `partial+${run}@example.com`,
            externalId: randomUUID(),
            firmId,
          },
        },
      );
      return res.data?.addClient.id ?? "";
    })());

  check("client exists", Boolean(clientId));
  if (!clientId) return report();

  section("Creating the split payment link");

  const link = await gql<{
    addPaymentLink: {
      id: string;
      url: string;
      status: string;
      partialPayment: { allowed: boolean };
      amounts: Array<{ amount: number; bankAccount: { category: string } }>;
      balance: { trustOutstanding: number; operatingOutstanding: number; totalOutstanding: number };
    };
  }>(
    firmToken,
    `mutation Add($input: AddPaymentLinkInput!) {
      addPaymentLink(input: $input) {
        id url status
        partialPayment { allowed }
        amounts { amount bankAccount { category } }
        balance { trustOutstanding operatingOutstanding totalOutstanding }
      }
    }`,
    {
      input: {
        clientId,
        memo: "Partial payment allocation probe",
        externalId: randomUUID(),
        trust: TRUST_CENTS,
        operating: OPERATING_CENTS,
        partialPaymentAllowed: true,
        // Off deliberately: a surcharge would land on top of the amount and
        // muddy the very numbers we are trying to read.
        surchargeEnabled: false,
      },
    },
  );

  if (link.errors.length || !link.data) {
    check("addPaymentLink", false, link.errors.map((e) => e.message));
    return report();
  }

  const created = link.data.addPaymentLink;
  check("link has two legs", created.amounts.length === 2, created.amounts);
  check("partial payment is allowed", created.partialPayment.allowed === true);
  check("trust leg is outstanding", created.balance.trustOutstanding === TRUST_CENTS);
  check("operating leg is outstanding", created.balance.operatingOutstanding === OPERATING_CENTS);

  writeState({
    firmId,
    firmToken,
    clientId,
    linkId: created.id,
    url: created.url,
    trustCents: TRUST_CENTS,
    operatingCents: OPERATING_CENTS,
    createdAt: new Date().toISOString(),
  });

  section("Pay this in a browser");

  console.log(`
  \x1b[1m\x1b[36m${created.url}\x1b[0m

  The link is for ${usd(TOTAL_CENTS)}:
    trust (filing fee)      ${usd(TRUST_CENTS)}
    operating (attorney fee) ${usd(OPERATING_CENTS)}

  \x1b[1mPay ${usd(SUGGESTED_CENTS)}\x1b[0m — less than the trust leg on its own, so each
  candidate rule gives a different answer:

    trust first      → trust ${usd(SUGGESTED_CENTS)}, operating ${usd(0)}
    operating first  → trust ${usd(0)}, operating ${usd(SUGGESTED_CENTS)}
    pro rata         → trust ${usd(5_000)}, operating ${usd(15_000)}

  \x1b[1mPay by ACH if the page offers it.\x1b[0m Any account and routing number
  succeeds in sandbox, and it leaves a transaction of type achPayment — which is
  the only way to reach sandboxOnlyTriggerAchReturn and settle the ACH-return
  question at the same time.

    ACH   account: any        routing: any
    Card  4242 4242 4242 4242, any future expiry, any CVC

  Then run:

    npm run check 15-confido-partial-payment -- inspect
`);

  await report();
};

// ─── inspect ─────────────────────────────────────────────────────────────────

const inspect = async () => {
  const state = readState();
  if (!state) {
    console.error(
      `\x1b[31mNo ${STATE_FILE}.\x1b[0m Run: npm run check 15-confido-partial-payment -- create`,
    );
    process.exit(1);
  }

  section("Link state");

  const link = await gql<{
    paymentLink: {
      status: string;
      balance: {
        totalPaid: number;
        totalOutstanding: number;
        trustPaid: number;
        trustOutstanding: number;
        operatingPaid: number;
        operatingOutstanding: number;
      };
    };
  }>(
    state.firmToken,
    `query L($id: String) {
      paymentLink(id: $id) {
        id status
        balance { totalPaid totalOutstanding trustPaid trustOutstanding operatingPaid operatingOutstanding }
      }
    }`,
    { id: state.linkId },
  );

  if (link.errors.length || !link.data) {
    check("paymentLink query", false, link.errors.map((e) => e.message));
    return report();
  }

  const { status, balance } = link.data.paymentLink;
  console.log(`  status: ${status}`);
  console.log(`  paid:        ${usd(balance.totalPaid)} of ${usd(TOTAL_CENTS)}`);
  console.log(`    trust:     ${usd(balance.trustPaid)} paid, ${usd(balance.trustOutstanding)} outstanding`);
  console.log(`    operating: ${usd(balance.operatingPaid)} paid, ${usd(balance.operatingOutstanding)} outstanding`);

  if (balance.totalPaid === 0) {
    console.log(
      `\n  \x1b[33mNothing paid yet.\x1b[0m Pay part of it here, then re-run inspect:\n  ${state.url}\n`,
    );
    check("a partial payment has been made", false, "totalPaid is 0");
    return report();
  }

  check("a payment has landed", balance.totalPaid > 0);
  check(
    "the payment is partial, not full",
    balance.totalPaid < TOTAL_CENTS,
    { paid: balance.totalPaid, total: TOTAL_CENTS },
  );

  section("Transactions");

  const txns = await gql<{
    transactionsList: {
      total: number;
      transactions: Array<{
        id: string;
        type: string;
        status_v2: string;
        amountProcessed: number;
        surchargeAmount: number;
        txnGroupId: string | null;
        paymentMethod: string;
        bankAccount: { id: string; category: string };
        payment: { id: string } | null;
      }>;
    };
  }>(
    state.firmToken,
    `query T($ids: [String!]) {
      transactionsList(paymentLinkIds: $ids) {
        total
        transactions {
          id type status_v2 amountProcessed surchargeAmount txnGroupId paymentMethod
          bankAccount { id category }
          payment { id }
        }
      }
    }`,
    { ids: [state.linkId] },
  );

  const rows = txns.data?.transactionsList.transactions ?? [];
  if (!rows.length) {
    check("transactions found for the link", false, txns.errors.map((e) => e.message));
    return report();
  }

  for (const t of rows) {
    console.log(
      `  ${t.bankAccount.category.padEnd(9)} ${usd(t.amountProcessed).padStart(10)}` +
        `  ${t.type} / ${t.paymentMethod} / ${t.status_v2}` +
        `  payment=${t.payment?.id?.slice(0, 8) ?? "—"} group=${t.txnGroupId ?? "null"}`,
    );
  }

  // ── The verdict ───────────────────────────────────────────────────────────
  section("Which allocation rule did Confido use?");

  const paid = balance.totalPaid;
  const trustPaid = balance.trustPaid;
  const operatingPaid = balance.operatingPaid;

  const trustFirst = {
    trust: Math.min(paid, TRUST_CENTS),
    operating: Math.max(paid - TRUST_CENTS, 0),
  };
  const operatingFirst = {
    operating: Math.min(paid, OPERATING_CENTS),
    trust: Math.max(paid - OPERATING_CENTS, 0),
  };
  const proRataTrust = Math.round((paid * TRUST_CENTS) / TOTAL_CENTS);
  const proRata = { trust: proRataTrust, operating: paid - proRataTrust };

  // A cent or two of rounding should not disqualify a rule that is otherwise
  // an exact match.
  const matches = (h: { trust: number; operating: number }) =>
    Math.abs(h.trust - trustPaid) <= 2 && Math.abs(h.operating - operatingPaid) <= 2;

  const candidates: Array<[string, { trust: number; operating: number }]> = [
    ["trust first", trustFirst],
    ["operating first", operatingFirst],
    ["pro rata", proRata],
  ];

  console.log(`  observed:         trust ${usd(trustPaid)} / operating ${usd(operatingPaid)}`);
  for (const [name, h] of candidates) {
    const hit = matches(h) ? "\x1b[32m ← MATCH\x1b[0m" : "";
    console.log(`  ${name.padEnd(17)} trust ${usd(h.trust)} / operating ${usd(h.operating)}${hit}`);
  }

  const winner = candidates.find(([, h]) => matches(h));
  console.log(
    winner
      ? `\n  \x1b[1mConfido allocates: ${winner[0]}\x1b[0m`
      : "\n  \x1b[33mNo candidate rule matches — the allocation is something else (see the transactions above).\x1b[0m",
  );

  check(
    "the observed split matches a known allocation rule",
    Boolean(winner),
    { trustPaid, operatingPaid },
  );

  // Our chosen policy is trust-first. Say plainly whether the processor agrees,
  // because a disagreement means our ledger and Confido's would drift apart on
  // every partial payment.
  const agreesWithPolicy = matches(trustFirst);
  check(
    "processor agrees with our trust-first policy",
    agreesWithPolicy,
    { expected: trustFirst, observed: { trust: trustPaid, operating: operatingPaid } },
  );
  if (!agreesWithPolicy) {
    console.log(
      "\n  \x1b[33mOur policy is trust-first but Confido did something else.\x1b[0m\n" +
        "  Either drive the allocation ourselves by issuing one link per account,\n" +
        "  or adopt Confido's rule so the two ledgers cannot drift.\n",
    );
  }

  // ── ACH follow-on ─────────────────────────────────────────────────────────
  const ach = rows.filter((t) => t.type === "achPayment");
  if (ach.length) {
    section("ACH return is now testable");
    console.log(
      `  ${ach.length} achPayment transaction(s) exist, so sandboxOnlyTriggerAchReturn\n` +
        "  can be fired against them to see whether a return unwinds one leg or both:\n" +
        ach.map((t) => `    ${t.id}  (${t.bankAccount.category}, ${usd(t.amountProcessed)})`).join("\n"),
    );
  } else {
    section("ACH return still untestable");
    console.log(
      "  No achPayment transactions on this link — the payment was made by card.\n" +
        "  Pay another partial by ACH to unlock the ACH-return question.",
    );
  }

  await report();
};

// ─── ach-return ──────────────────────────────────────────────────────────────

type TxnRow = {
  id: string;
  type: string;
  status_v2: string;
  amountProcessed: number;
  achReturnCode: string | null;
  achReturnReason: string | null;
  originalTransactionId: string | null;
  bankAccount: { category: string };
};

const TXN_QUERY = `query T($ids: [String!]) {
  transactionsList(paymentLinkIds: $ids) {
    transactions {
      id type status_v2 amountProcessed achReturnCode achReturnReason originalTransactionId
      bankAccount { category }
    }
  }
}`;

const BALANCE_QUERY = `query L($id: String) {
  paymentLink(id: $id) {
    status
    balance { totalPaid trustPaid trustOutstanding operatingPaid operatingOutstanding }
  }
}`;

type Bal = {
  totalPaid: number;
  trustPaid: number;
  trustOutstanding: number;
  operatingPaid: number;
  operatingOutstanding: number;
};

/**
 * Settle an ACH payment, then return it — the last open question from the
 * review.
 *
 * ACH returns are the failure mode that makes trust accounting genuinely hard:
 * money we have already recorded as received, and possibly already opened a case
 * on, is pulled back out days later. Our `invoice_payments` table cannot express
 * that today (`check(amount > 0)`, insert-only), so what shape Confido reports a
 * return in decides what shape our schema needs.
 *
 * The transaction is settled first because the docs describe returns as
 * happening to money that has already landed. Firing at a PENDING transaction
 * would be testing something that does not occur in production.
 */
const achReturn = async () => {
  const state = readState();
  if (!state) {
    console.error(
      `\x1b[31mNo ${STATE_FILE}.\x1b[0m Run: npm run check 15-confido-partial-payment -- create`,
    );
    process.exit(1);
  }

  const balanceOf = async (): Promise<Bal | null> => {
    const res = await gql<{ paymentLink: { status: string; balance: Bal } }>(
      state.firmToken,
      BALANCE_QUERY,
      { id: state.linkId },
    );
    return res.data?.paymentLink.balance ?? null;
  };

  const txnsOf = async (): Promise<TxnRow[]> => {
    const res = await gql<{ transactionsList: { transactions: TxnRow[] } }>(
      state.firmToken,
      TXN_QUERY,
      { ids: [state.linkId] },
    );
    return res.data?.transactionsList.transactions ?? [];
  };

  section("Before");

  const before = await balanceOf();
  const rowsBefore = await txnsOf();
  if (!before) {
    check("paymentLink balance", false, "query failed");
    return report();
  }

  console.log(`  trust:     ${usd(before.trustPaid)} paid, ${usd(before.trustOutstanding)} outstanding`);
  console.log(`  operating: ${usd(before.operatingPaid)} paid, ${usd(before.operatingOutstanding)} outstanding`);

  const target = rowsBefore.find((t) => t.type === "achPayment");
  check("an achPayment transaction exists to return", Boolean(target), rowsBefore.map((t) => t.type));
  if (!target) {
    console.log("\n  Pay a partial by ACH first, then re-run this mode.\n");
    return report();
  }
  console.log(
    `\n  target: ${target.id}  ${target.bankAccount.category} ${usd(target.amountProcessed)} (${target.status_v2})`,
  );

  // ── Settle it ─────────────────────────────────────────────────────────────
  section("Settling the ACH payment");

  for (const mutation of [
    "sandboxOnlyMoveTransactionToFundsInTransit",
    "sandboxOnlyMoveTransactionToDeposited",
  ]) {
    const res = await gql<Record<string, boolean>>(
      state.firmToken,
      `mutation M($input: SandboxOnlyMoveTransactionInput!) { ${mutation}(input: $input) }`,
      { input: { transactionId: target.id } },
    );
    const passed = res.errors.length === 0 && res.data?.[mutation] === true;
    check(mutation, passed, res.errors.map((e) => e.message));
    // Keep going even on failure: a return fired at whatever status we reached
    // is still more informative than stopping here.
  }

  const settled = (await txnsOf()).find((t) => t.id === target.id);
  console.log(`  status now: ${settled?.status_v2}`);
  check(
    "the ACH payment reached DEPOSITED",
    settled?.status_v2 === "DEPOSITED",
    settled?.status_v2,
  );

  const afterSettle = await balanceOf();
  console.log(
    `  balance after settling: trust ${usd(afterSettle?.trustPaid ?? 0)} paid, ` +
      `${usd(afterSettle?.trustOutstanding ?? 0)} outstanding`,
  );

  // ── Return it ─────────────────────────────────────────────────────────────
  section("Triggering the ACH return");

  const returned = await gql<Record<string, boolean>>(
    state.firmToken,
    `mutation R($input: SandboxOnlyTriggerAchReturnInput!) { sandboxOnlyTriggerAchReturn(input: $input) }`,
    { input: { transactionId: target.id } },
  );
  check(
    "sandboxOnlyTriggerAchReturn",
    returned.errors.length === 0 && returned.data?.sandboxOnlyTriggerAchReturn === true,
    returned.errors.map((e) => e.message),
  );
  if (returned.errors.length) return report();

  section("After");

  const after = await balanceOf();
  const rowsAfter = await txnsOf();

  console.log(`  trust:     ${usd(after?.trustPaid ?? 0)} paid, ${usd(after?.trustOutstanding ?? 0)} outstanding`);
  console.log(`  operating: ${usd(after?.operatingPaid ?? 0)} paid, ${usd(after?.operatingOutstanding ?? 0)} outstanding`);
  console.log("\n  transactions:");
  for (const t of rowsAfter) {
    console.log(
      `    ${t.bankAccount.category.padEnd(9)} ${usd(t.amountProcessed).padStart(10)}` +
        `  ${t.type.padEnd(11)} ${t.status_v2.padEnd(16)}` +
        (t.achReturnCode ? ` code=${t.achReturnCode} (${t.achReturnReason})` : "") +
        (t.originalTransactionId ? ` orig=${t.originalTransactionId.slice(0, 8)}` : ""),
    );
  }

  // ── What the return actually did ──────────────────────────────────────────
  section("What a return does to the ledger");

  const newRows = rowsAfter.filter((t) => !rowsBefore.some((b) => b.id === t.id));
  const originalNow = rowsAfter.find((t) => t.id === target.id);

  check(
    "the returned money left the trust balance",
    (after?.trustPaid ?? 0) === (afterSettle?.trustPaid ?? 0) - target.amountProcessed,
    { before: afterSettle?.trustPaid, after: after?.trustPaid, returned: target.amountProcessed },
  );
  check(
    "the operating leg was NOT touched",
    (after?.operatingPaid ?? 0) === before.operatingPaid,
    { before: before.operatingPaid, after: after?.operatingPaid },
  );
  check(
    "the original transaction is now RETURNED",
    originalNow?.status_v2 === "RETURNED",
    originalNow?.status_v2,
  );
  check(
    "a separate reversing transaction was created",
    newRows.length > 0,
    newRows.map((t) => ({ type: t.type, amount: t.amountProcessed, status: t.status_v2 })),
  );

  for (const t of newRows) {
    console.log(
      `\n  reversing row: type=${t.type} amount=${usd(t.amountProcessed)} ` +
        `status=${t.status_v2} code=${t.achReturnCode ?? "—"} reason=${t.achReturnReason ?? "—"}`,
    );
    check(
      `reversing row (${t.type}) carries a positive amount, not a negative one`,
      t.amountProcessed > 0,
      t.amountProcessed,
    );
    check(
      `reversing row (${t.type}) points back at the original`,
      t.originalTransactionId === target.id,
      { originalTransactionId: t.originalTransactionId, expected: target.id },
    );
  }

  console.log(
    "\n  \x1b[1mSchema implication:\x1b[0m a return is a SEPARATE transaction with a positive\n" +
      "  amount pointing at the original, not a mutation of the original row. Our\n" +
      "  `invoice_payments` can mirror that with a `kind` column plus a self-reference —\n" +
      "  the `check(amount > 0)` constraint can stay as it is.\n",
  );

  await report();
};

// ─── entry ───────────────────────────────────────────────────────────────────

const main = async () => {
  const args = process.argv.slice(2);
  const mode = args.find((a) => !a.startsWith("-")) ?? "create";

  if (mode === "inspect") return inspect();
  if (mode === "ach-return") return achReturn();
  if (mode === "create") return create(!args.includes("--new"));

  console.error(`Unknown mode "${mode}". Use: create [--new] | inspect | ach-return`);
  process.exit(1);
};

main().catch(async (err) => {
  console.error("\x1b[31mCrashed:\x1b[0m", err);
  await report();
});
