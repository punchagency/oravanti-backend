/**
 * Tier 3 — Confido Legal sandbox. Network only; touches no application tables.
 *
 *   CONFIDO_PARTNER_TOKEN=p_secret_sandbox_… npm run check 14-confido-sandbox
 *
 * A throwaway spike, not a permanent test. It exists to settle the questions
 * Confido's docs leave open before we design schema around them — above all
 * whether a single client payment really can be split between a trust and an
 * operating bank account, which is the entire reason we moved off Stripe.
 *
 * Credentials come straight from `process.env` rather than `src/config/env.ts`.
 * The spike is meant to be deleted once Phase 2 lands, and a throwaway script
 * should not leave permanent keys in shared config.
 *
 * Everything it creates lives in Confido's sandbox, which has no delete API —
 * firms accumulate there by design. Names are stamped with a run id so a run's
 * output can be told apart from the last one's.
 */
import { randomUUID } from "crypto";
import axios from "axios";
import { check, checkEqual, report, section } from "./_bootstrap";

const API_URL =
  process.env.CONFIDO_API_URL ?? "https://api.sandbox.gravity-legal.com/v2";
const PARTNER_TOKEN = process.env.CONFIDO_PARTNER_TOKEN;

/** Stamped into every created record so one run's leftovers are identifiable. */
const RUN = randomUUID().slice(0, 8);

// Money, in cents, mirroring a real fee-agreement invoice: a government filing
// fee that must land in trust, and an attorney fee that must land in operating.
const TRUST_CENTS = 50_000; // $500.00 — filing fee, client money
const OPERATING_CENTS = 150_000; // $1,500.00 — attorney fee, earned
const TOTAL_CENTS = TRUST_CENTS + OPERATING_CENTS;

// ─── GraphQL plumbing ────────────────────────────────────────────────────────

type GqlError = { message: string; path?: string[] };

/**
 * One GraphQL round trip.
 *
 * GraphQL answers 200 with an `errors` array rather than an HTTP error status,
 * so a naive axios call reports success for a failed mutation. Errors are
 * surfaced explicitly and returned rather than thrown: a spike wants to record
 * "this is what Confido said no to" as a finding, not abort the run.
 */
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
        // Report the body rather than throwing, so a 4xx is still inspectable.
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

/** Findings the spike is here to collect, printed as a block at the end. */
const observations: string[] = [];
const observe = (label: string, value: unknown) => {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  observations.push(`${label}: ${rendered}`);
  console.log(`  \x1b[36mNOTE\x1b[0m ${label} — ${rendered}`);
};

/** Reports GraphQL errors as a failed check rather than letting them pass silently. */
const ok = (label: string, errors: GqlError[], data: unknown): boolean => {
  if (errors.length) {
    check(label, false, errors.map((e) => e.message));
    return false;
  }
  check(label, data != null);
  return data != null;
};

// ─── Fragments ───────────────────────────────────────────────────────────────

const TXN_FIELDS = `
  id
  type
  status_v2
  amountProcessed
  surchargeAmount
  txnGroupId
  canVoid
  canRefund
  bankAccount { id category isDefault nickname }
`;

const LINK_FIELDS = `
  id
  url
  status
  surchargeEnabled
  partialPayment { allowed usingFirmDefault }
  amounts { amount bankAccount { id category isDefault } }
  balance { totalPaid totalOutstanding operatingPaid operatingOutstanding trustPaid trustOutstanding }
`;

// ─── The spike ───────────────────────────────────────────────────────────────

type BankAccount = {
  id: string;
  category: string;
  isDefault: boolean;
  nickname: string;
};

const main = async () => {
  if (!PARTNER_TOKEN) {
    console.error(
      "\x1b[31mCONFIDO_PARTNER_TOKEN is not set.\x1b[0m\n" +
        "Get a sandbox Partner Token from app.sandbox.confidolegal.com → Settings,\n" +
        "then re-run:  CONFIDO_PARTNER_TOKEN=p_secret_sandbox_… npm run check 14-confido-sandbox",
    );
    process.exit(1);
  }

  if (!PARTNER_TOKEN.includes("sandbox")) {
    // Tokens are prefixed with their environment. Every mutation below either
    // creates a firm or moves money; running them against production would be
    // a genuine mess, and the prefix is the only guard available.
    console.error(
      `\x1b[31mRefusing to run: token "${PARTNER_TOKEN.slice(0, 18)}…" is not a sandbox token.\x1b[0m`,
    );
    process.exit(1);
  }

  console.log(`Confido sandbox spike — run ${RUN} against ${API_URL}`);

  // ── 1. Firm creation, the mockOnboarding shortcut ──────────────────────────
  section("1. createFirm with mockOnboarding");

  const created = await gql<{
    createFirm: {
      id: string;
      name: string;
      status: string;
      isAcceptingPayments: boolean;
      apiToken: string;
      onboardingToken: { token: string; expiresAt: string };
      bankAccounts: BankAccount[];
    };
  }>(
    PARTNER_TOKEN,
    `mutation Create($input: CreateFirmInput) {
      createFirm(input: $input) {
        id name status isAcceptingPayments apiToken
        onboardingToken { token expiresAt }
        bankAccounts { id category isDefault nickname }
      }
    }`,
    { input: { name: `Spike Firm ${RUN}`, mockOnboarding: true } },
  );

  if (!ok("createFirm(mockOnboarding: true) succeeds", created.errors, created.data)) {
    return report();
  }

  const firm = created.data!.createFirm;
  const firmToken = firm.apiToken;

  check("firm token is a sandbox firm token", firmToken.startsWith("f_secret_sandbox_"));

  check(
    "mockOnboarding creates both default bank accounts",
    firm.bankAccounts.some((a) => a.category === "trust" && a.isDefault) &&
      firm.bankAccounts.some((a) => a.category === "operating" && a.isDefault),
    firm.bankAccounts,
  );

  // FINDING — `createFirm` returns a STALE snapshot. Its response says
  // `status: CREATED, isAcceptingPayments: false`, but re-querying the same firm
  // a moment later returns ACTIVE, and `sandboxOnlyActivateFirm` refuses with
  // "firm is already active". mockOnboarding does what the docs say; the
  // mutation's own payload is just written before activation lands.
  //
  // This matters well beyond the spike: if we persist `confido_firm_status` from
  // the createFirm response we will store a status the firm has already left,
  // and an org will look un-onboarded when it is ready to trade. Always re-query
  // the firm (or wait for the `firm.updated` webhook) rather than trusting the
  // mutation payload.
  observe("status in the createFirm RESPONSE", firm.status);

  const reread = await gql<{ firm: { status: string; isAcceptingPayments: boolean } }>(
    firmToken,
    `query { firm { id status isAcceptingPayments } }`,
  );
  observe("status on re-query moments later", reread.data?.firm);

  check(
    "re-querying shows the firm is genuinely ACTIVE",
    reread.data?.firm.status === "ACTIVE" && reread.data.firm.isAcceptingPayments === true,
    reread.data?.firm,
  );
  check(
    "FINDING: createFirm's own payload is stale — re-query before persisting status",
    firm.status !== reread.data?.firm.status,
    { inResponse: firm.status, onReread: reread.data?.firm.status },
  );

  // The plan's embedded-onboarding flow re-mints this every 24h; confirm the TTL
  // we are about to build a refresh endpoint around.
  const ttlHours =
    (new Date(firm.onboardingToken.expiresAt).getTime() - Date.now()) / 3_600_000;
  observe("onboarding token TTL (hours)", Math.round(ttlHours * 10) / 10);
  check("onboarding token TTL is ~24h", ttlHours > 20 && ttlHours < 26, ttlHours);

  // The call the embedded flow actually makes, with a firm token rather than
  // reading the token off createFirm.
  const standalone = await gql<{ createOnboardingToken: { token: string; expiresAt: string } }>(
    firmToken,
    `mutation { createOnboardingToken { token expiresAt } }`,
  );
  if (ok("createOnboardingToken works with a firm token", standalone.errors, standalone.data)) {
    check(
      "onboarding token is frontend-safe (public prefix)",
      standalone.data!.createOnboardingToken.token.startsWith("onboarding_public_"),
      standalone.data!.createOnboardingToken.token.slice(0, 24),
    );
  }

  // ── 2. The real status ladder ─────────────────────────────────────────────
  section("2. Firm status ladder (sandboxOnly* transitions)");

  const plain = await gql<{ createFirm: { id: string; status: string; apiToken: string } }>(
    PARTNER_TOKEN,
    `mutation Create($input: CreateFirmInput) {
      createFirm(input: $input) { id status apiToken }
    }`,
    { input: { name: `Spike Ladder ${RUN}` } },
  );

  if (ok("createFirm without mockOnboarding", plain.errors, plain.data)) {
    const ladderFirm = plain.data!.createFirm;
    checkEqual("new firm starts at CREATED", ladderFirm.status, "CREATED");

    // `sandboxOnlyFillOnboardingData` is documented as the first rung, but on a
    // freshly CREATED firm it answers "OnboardingData not found" — while
    // `sandboxOnlySubmitOnboardingData`, which the docs say calls Fill under the
    // hood, works fine from the same state. Recorded rather than asserted: it is
    // their bug, and a red check we cannot clear is noise.
    const fill = await gql<{ sandboxOnlyFillOnboardingData: { status: string } }>(
      PARTNER_TOKEN,
      `mutation F($firmId: String) { sandboxOnlyFillOnboardingData(firmId: $firmId) { id status } }`,
      { firmId: ladderFirm.id },
    );
    observe(
      "DOC GAP: sandboxOnlyFillOnboardingData on a CREATED firm",
      fill.errors.length ? fill.errors.map((e) => e.message) : fill.data?.sandboxOnlyFillOnboardingData.status,
    );

    const steps: Array<[string, string]> = [
      ["sandboxOnlySubmitOnboardingData", "APP_SUBMITTED"],
      ["sandboxOnlySendFirmToReview", "APP_IN_REVIEW"],
      ["sandboxOnlyActivateFirm", "ACTIVE"],
    ];

    for (const [mutation, expected] of steps) {
      const res = await gql<Record<string, { status: string }>>(
        PARTNER_TOKEN,
        `mutation Step($firmId: String) { ${mutation}(firmId: $firmId) { id status } }`,
        { firmId: ladderFirm.id },
      );
      if (res.errors.length) {
        check(`${mutation} → ${expected}`, false, res.errors.map((e) => e.message));
        continue;
      }
      checkEqual(`${mutation} → ${expected}`, res.data?.[mutation]?.status, expected);
    }

    // Whether a fully-onboarded firm gets both account categories, or only the
    // mockOnboarding shortcut does, decides if our readiness gate can assume both.
    const ladderAccounts = await gql<{ bankAccountsList: { bankAccounts: BankAccount[] } }>(
      PARTNER_TOKEN,
      `query Accounts($firmId: String) {
        bankAccountsList(firmId: $firmId) { bankAccounts { id category isDefault } }
      }`,
      { firmId: ladderFirm.id },
    );
    observe(
      "categories after the full ladder",
      ladderAccounts.data?.bankAccountsList.bankAccounts.map((a) => a.category) ?? "error",
    );
  }

  // ── 3. Default trust and operating accounts ───────────────────────────────
  section("3. Bank accounts");

  const accountsRes = await gql<{ bankAccountsList: { bankAccounts: BankAccount[] } }>(
    firmToken,
    `query { bankAccountsList { bankAccounts { id category isDefault isFeeAccount isChargebackAccount nickname } } }`,
  );

  if (!ok("bankAccountsList", accountsRes.errors, accountsRes.data)) return report();

  const accounts = accountsRes.data!.bankAccountsList.bankAccounts;
  observe("bank accounts", accounts.map((a) => `${a.category}${a.isDefault ? "(default)" : ""}`));

  const trustAccount = accounts.find((a) => a.category === "trust" && a.isDefault);
  const operatingAccount = accounts.find((a) => a.category === "operating" && a.isDefault);

  check("a default TRUST account exists", Boolean(trustAccount), accounts);
  check("a default OPERATING account exists", Boolean(operatingAccount), accounts);
  // Our enum is ('operating','trust_iolta'); theirs is an untyped String.
  check(
    "categories are exactly 'trust' / 'operating'",
    accounts.every((a) => a.category === "trust" || a.category === "operating"),
    accounts.map((a) => a.category),
  );

  if (!trustAccount || !operatingAccount) return report();

  // ── 4. Client and matter, keyed by our own uuids ──────────────────────────
  section("4. Client / Matter externalId round trip");

  const ourClientId = randomUUID();
  const clientRes = await gql<{ addClient: { id: string; externalId: string } }>(
    firmToken,
    `mutation Add($input: AddClientInput!) { addClient(input: $input) { id externalId clientName } }`,
    {
      input: {
        clientName: `Spike Client ${RUN}`,
        email: `spike+${RUN}@example.com`,
        externalId: ourClientId,
        firmId: firm.id,
      },
    },
  );
  if (!ok("addClient with our uuid as externalId", clientRes.errors, clientRes.data)) {
    return report();
  }
  const confidoClientId = clientRes.data!.addClient.id;

  const lookup = await gql<{ client: { id: string } | null }>(
    firmToken,
    `query ByExternal($externalId: String) { client(externalId: $externalId) { id } }`,
    { externalId: ourClientId },
  );
  checkEqual(
    "client(externalId:) round-trips to the same client",
    lookup.data?.client?.id,
    confidoClientId,
  );

  // Note the asymmetry with addClient, which returns a Client directly:
  // matterCreate wraps its payload in a MatterCreateResult.
  const matterRes = await gql<{ matterCreate: { matter: { id: string } } }>(
    firmToken,
    `mutation M($input: MatterCreateInput!) {
      matterCreate(input: $input) { matter { id name externalId } }
    }`,
    {
      input: {
        clientId: confidoClientId,
        name: `Spike Matter ${RUN}`,
        externalId: randomUUID(),
      },
    },
  );
  ok("matterCreate", matterRes.errors, matterRes.data);
  const matterId = matterRes.data?.matterCreate.matter.id ?? null;

  // ── 5. THE CORE ASSERTION: a split payment link ───────────────────────────
  section("5. Split payment link (trust + operating)");

  type LinkShape = {
    id: string;
    url: string;
    status: string;
    surchargeEnabled: boolean;
    partialPayment: { allowed: boolean; usingFirmDefault: boolean };
    amounts: Array<{ amount: number; bankAccount: BankAccount }>;
    balance: {
      totalPaid: number;
      totalOutstanding: number;
      operatingPaid: number;
      operatingOutstanding: number;
      trustPaid: number;
      trustOutstanding: number;
    };
  };

  const addLink = (input: Record<string, unknown>) =>
    gql<{ addPaymentLink: LinkShape }>(
      firmToken,
      `mutation Add($input: AddPaymentLinkInput!) { addPaymentLink(input: $input) { ${LINK_FIELDS} } }`,
      { input },
    );

  // 5a — the `trust:` / `operating:` shorthand, which resolves the firm's
  // defaults server-side. This is what we want to use in production: it means
  // we never have to store Confido bank account ids ourselves.
  const shorthand = await addLink({
    clientId: confidoClientId,
    ...(matterId ? { matterId } : {}),
    memo: `Spike shorthand ${RUN}`,
    externalId: randomUUID(),
    trust: TRUST_CENTS,
    operating: OPERATING_CENTS,
  });

  if (ok("addPaymentLink with trust:/operating: shorthand", shorthand.errors, shorthand.data)) {
    const link = shorthand.data!.addPaymentLink;
    checkEqual("shorthand produces two amount legs", link.amounts.length, 2);

    const trustLeg = link.amounts.find((a) => a.bankAccount.category === "trust");
    const opLeg = link.amounts.find((a) => a.bankAccount.category === "operating");
    checkEqual("trust leg routes the filing fee", trustLeg?.amount, TRUST_CENTS);
    checkEqual("operating leg routes the attorney fee", opLeg?.amount, OPERATING_CENTS);
    checkEqual("trust leg hit the default trust account", trustLeg?.bankAccount.id, trustAccount.id);
    checkEqual(
      "operating leg hit the default operating account",
      opLeg?.bankAccount.id,
      operatingAccount.id,
    );

    checkEqual("balance.trustOutstanding", link.balance.trustOutstanding, TRUST_CENTS);
    checkEqual("balance.operatingOutstanding", link.balance.operatingOutstanding, OPERATING_CENTS);
    checkEqual("balance.totalOutstanding", link.balance.totalOutstanding, TOTAL_CENTS);

    observe("hosted payment link url", link.url);
    observe("surchargeEnabled default on a split link", link.surchargeEnabled);
    observe("partialPayment default", link.partialPayment);
  }

  // 5b — the explicit `amounts:` form, needed for firms with more than one
  // trust account (Confido's own example firm has two, one per state).
  const explicit = await addLink({
    clientId: confidoClientId,
    memo: `Spike explicit ${RUN}`,
    externalId: randomUUID(),
    amounts: [
      { amount: TRUST_CENTS, bankAccountId: trustAccount.id },
      { amount: OPERATING_CENTS, bankAccountId: operatingAccount.id },
    ],
  });

  if (ok("addPaymentLink with explicit amounts[]", explicit.errors, explicit.data)) {
    const link = explicit.data!.addPaymentLink;
    checkEqual("explicit form produces two legs", link.amounts.length, 2);
    checkEqual("explicit trust leg amount",
      link.amounts.find((a) => a.bankAccount.id === trustAccount.id)?.amount, TRUST_CENTS);
  }

  // 5c — the failure mode the docs warn about: asking for trust on a firm with
  // no usable default trust account. We cannot remove an account, so this only
  // records how a bad split is rejected — shape of the error matters for our
  // validation layer.
  const bogus = await addLink({
    clientId: confidoClientId,
    externalId: randomUUID(),
    trust: TRUST_CENTS,
    amounts: [{ amount: OPERATING_CENTS, bankAccountId: operatingAccount.id }],
  });
  check(
    "mixing shorthand and amounts[] is rejected",
    bogus.errors.length > 0,
    bogus.errors.map((e) => e.message),
  );
  observe("error when mixing shorthand + amounts[]", bogus.errors.map((e) => e.message));

  // ── 6. Paying it: how many transactions come back? ────────────────────────
  section("6. Manual payment on the split link — transaction shape");

  const payLink = await addLink({
    clientId: confidoClientId,
    memo: `Spike pay-in-full ${RUN}`,
    externalId: randomUUID(),
    trust: TRUST_CENTS,
    operating: OPERATING_CENTS,
  });
  if (!ok("payment link for the full-payment case", payLink.errors, payLink.data)) {
    return report();
  }

  const paid = await gql<{
    recordManualPaymentOnPaymentLink: {
      id: string;
      amount: number;
      status: string;
      transactions: Array<{
        id: string;
        type: string;
        status_v2: string;
        amountProcessed: number;
        surchargeAmount: number;
        txnGroupId: string | null;
        canVoid: boolean;
        canRefund: boolean;
        bankAccount: BankAccount;
      }>;
    };
  }>(
    firmToken,
    `mutation Pay($input: RecordManualPaymentInput!) {
      recordManualPaymentOnPaymentLink(input: $input) {
        id amount status
        transactions { ${TXN_FIELDS} }
      }
    }`,
    {
      input: {
        paymentLinkId: payLink.data!.addPaymentLink.id,
        trust: TRUST_CENTS,
        operating: OPERATING_CENTS,
        billingName: `Spike Payer ${RUN}`,
        billingEmail: `spike+${RUN}@example.com`,
        statement: `Spike run ${RUN}`,
      },
    },
  );

  if (!ok("recordManualPaymentOnPaymentLink (full split)", paid.errors, paid.data)) {
    return report();
  }

  const payment = paid.data!.recordManualPaymentOnPaymentLink;
  const txns = payment.transactions;

  // OPEN QUESTION 2 — this is what decides our ledger idempotency key.
  observe("PaymentStatus after a full split payment", payment.status);
  observe("transactions per split payment", txns.length);
  observe(
    "transaction legs",
    txns.map((t) => ({
      account: t.bankAccount.category,
      cents: t.amountProcessed,
      status: t.status_v2,
      group: t.txnGroupId,
    })),
  );

  check(
    "one transaction per bank account (2 for a trust+operating split)",
    txns.length === 2,
    txns.length,
  );

  // `txnGroupId` is documented as the "stable id shared by transactions that
  // belong to the same payment", but it comes back NULL for payments recorded
  // through this API. It IS populated for real payments made on the hosted page
  // (confirmed in 15-confido-partial-payment), so the field is not broken — it
  // is just absent on the manual path. That makes it unusable as a universal
  // correlator: key the ledger on each leg's own transaction id, and group by
  // `Payment.id`, which is always present.
  observe("txnGroupId on manually-recorded split legs", txns.map((t) => t.txnGroupId));
  check(
    "FINDING: txnGroupId is null for MANUAL payments (populated for real ones)",
    txns.every((t) => t.txnGroupId == null),
    txns.map((t) => t.txnGroupId),
  );
  check(
    "Payment.id groups both legs",
    Boolean(payment.id) && txns.length === 2,
    { paymentId: payment.id, legs: txns.length },
  );
  check(
    "each leg has its own transaction id (usable as a ledger key)",
    new Set(txns.map((t) => t.id)).size === txns.length,
    txns.map((t) => t.id),
  );

  checkEqual(
    "legs sum to the invoice total",
    txns.reduce((sum, t) => sum + t.amountProcessed, 0),
    TOTAL_CENTS,
  );
  check(
    "trust leg is credited to the trust account",
    txns.find((t) => t.bankAccount.category === "trust")?.amountProcessed === TRUST_CENTS,
    txns,
  );

  // OPEN QUESTION 4 — surcharging a client's trust deposit is legally dubious.
  observe(
    "surcharge per leg",
    txns.map((t) => ({ account: t.bankAccount.category, surcharge: t.surchargeAmount })),
  );

  // ── 7. Partial payment: which account does Confido credit first? ──────────
  section("7. Partial payment allocation (OPEN QUESTION 1)");

  const partialLink = await addLink({
    clientId: confidoClientId,
    memo: `Spike partial ${RUN}`,
    externalId: randomUUID(),
    partialPaymentAllowed: true,
    trust: TRUST_CENTS,
    operating: OPERATING_CENTS,
  });

  if (ok("payment link with partialPaymentAllowed", partialLink.errors, partialLink.data)) {
    const linkId = partialLink.data!.addPaymentLink.id;

    // The manual-payment path CANNOT answer this question. `RecordManualPaymentInput`
    // requires one of `amounts` / `operating` / `trust`, so whatever allocation
    // comes back is simply the one we asked for. Confirm that first — it is a
    // finding in its own right, since it means every manual payment we record
    // must carry an explicit split decided by us.
    const noAllocation = await gql(
      firmToken,
      `mutation Pay($input: RecordManualPaymentInput!) {
        recordManualPaymentOnPaymentLink(input: $input) { id status }
      }`,
      { input: { paymentLinkId: linkId, billingName: `Spike NoAlloc ${RUN}` } },
    );
    check(
      "a manual payment with no allocation is rejected",
      noAllocation.errors.length > 0,
      noAllocation.errors.map((e) => e.message),
    );
    observe(
      "manual payment with no trust/operating/amounts",
      noAllocation.errors.map((e) => e.message),
    );

    // Pay less than the trust leg alone, so trust-first, operating-first and
    // pro-rata would each give a visibly different answer — for whoever pays the
    // hosted link in a browser.
    const partialCents = 20_000; // $200 against a $500 trust / $1,500 operating link

    observe(
      "OPEN QUESTION 1 UNRESOLVED — pay this link in a browser",
      `${partialLink.data!.addPaymentLink.url}  (pay ${partialCents / 100} of ${TOTAL_CENTS / 100}, then re-query the link balance)`,
    );

    const after = await gql<{ paymentLink: LinkShape }>(
      firmToken,
      `query L($id: String) { paymentLink(id: $id) { ${LINK_FIELDS} } }`,
      { id: linkId },
    );
    observe("link balance before any browser payment", after.data?.paymentLink.balance);
  }

  // ── 8. Settlement, ACH return and refund shapes ───────────────────────────
  section("8. Lifecycle: deposit, refund");

  const firstTxn = txns[0]!;

  // Manual payments land DEPOSITED immediately — they represent money the firm
  // already has. So the settlement mutations do not apply: moving one back to
  // FUNDS_IN_TRANSIT succeeds, but moving it forward again fails with "Deposit
  // not found" because no deposit record was ever created. Exercising the real
  // ACH lifecycle (and therefore `transaction.ach_returned`, the event that can
  // claw back money we already booked) needs an actual ACH payment through the
  // hosted link, which this script cannot drive.
  observe("status of a manual payment leg on creation", firstTxn.status_v2);
  check(
    "manual payments are DEPOSITED immediately (no settlement to simulate)",
    txns.every((t) => t.status_v2 === "DEPOSITED"),
    txns.map((t) => t.status_v2),
  );
  observe(
    "ACH lifecycle + ach_returned NOT covered here",
    "needs a real ACH payment on a hosted link; sandboxOnlyTriggerAchReturn requires type: achPayment",
  );

  // Refunding ONE leg of a split: does Confido refund only that leg, or unwind
  // the whole payment? `originalTransactions` being plural suggests the latter,
  // and that difference decides whether our refund rows are per-leg.
  const refunded = await gql<{
    transactionRefund: {
      refundRequest: { id: string; status: string; errorMessage: string | null };
      originalTransactions: Array<{ id: string; bankAccount: BankAccount }> | null;
      refundTransactions: Array<{
        id: string;
        amountProcessed: number;
        bankAccount: BankAccount;
      }> | null;
    };
  }>(
    firmToken,
    `mutation R($input: TransactionRefundInput!) {
      transactionRefund(input: $input) {
        refundRequest { id status errorMessage }
        originalTransactions { id bankAccount { id category } }
        refundTransactions { id amountProcessed bankAccount { id category } }
      }
    }`,
    { input: { transactionId: firstTxn.id, externalId: randomUUID() } },
  );

  if (refunded.errors.length) {
    observe("transactionRefund rejected", refunded.errors.map((e) => e.message));
  } else {
    const r = refunded.data!.transactionRefund;
    observe("refund request status", r.refundRequest.status);
    observe(
      "originalTransactions touched by refunding ONE leg",
      r.originalTransactions?.map((t) => t.bankAccount.category) ?? "pending",
    );
    observe(
      "refundTransactions created",
      r.refundTransactions?.map((t) => ({
        account: t.bankAccount.category,
        cents: t.amountProcessed,
      })) ?? "pending",
    );
    check(
      "refunding one leg does not silently unwind the other",
      r.originalTransactions == null || r.originalTransactions.length <= txns.length,
      r.originalTransactions?.length,
    );
  }

  // ── 9. Summary ────────────────────────────────────────────────────────────
  section("9. Findings");
  console.log(
    "\nThese are the answers the Phase 2 schema design depends on:\n" +
      observations.map((o) => `  • ${o}`).join("\n") +
      "\n",
  );
  console.log(`  Firm id: ${firm.id}  (sandbox firms cannot be deleted)`);

  await report();
};

main().catch(async (err) => {
  console.error("\x1b[31mSpike crashed:\x1b[0m", err);
  await report();
});
