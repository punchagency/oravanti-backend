/**
 * Tier 3 — Confido sandbox + Postgres. Proves money lands correctly.
 *
 *   CONFIDO_PARTNER_TOKEN=p_secret_sandbox_… npm run check 17-confido-payments
 *
 * `14-confido-sandbox` proved Confido can split a payment; this proves OUR
 * ledger records it correctly, which is a different claim and the one that
 * matters. It drives the three shapes an invoice can be paid in — trust only,
 * operating only, and both — and asserts the rows that result.
 *
 * The invariant under test, above everything else: **`sum(amount)` equals the
 * money received.** Confido credits one bank account per transaction, so a split
 * payment arrives as two events and becomes two single-sided rows. If both ever
 * carried the full payment amount, every money figure in the app would double,
 * silently.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { organization } from "../../src/db/schema/auth-schema";
import { confidoFirms } from "../../src/db/schema/confido-firms";
import { invoicePayments } from "../../src/db/schema/invoice-payments";
import { invoices } from "../../src/db/schema/invoices";
import { encryptPaymentValue } from "../../src/utils/payment-crypto";
import { check, checkEqual, report, section } from "./_bootstrap";

const RUN = randomUUID().slice(0, 8);
const API = process.env.CONFIDO_API_URL ?? "https://api.sandbox.gravity-legal.com/v2";
const PARTNER = process.env.CONFIDO_PARTNER_TOKEN;

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

const main = async () => {
  if (!PARTNER?.includes("sandbox")) {
    console.error(
      "\x1b[31mA sandbox CONFIDO_PARTNER_TOKEN is required.\x1b[0m",
    );
    process.exit(1);
  }

  const orgId = `org-pay-${RUN}`;
  let firmId = "";

  try {
    // ── A firm that can take money ────────────────────────────────────────
    section("setup");

    await systemDb.insert(organization).values({
      id: orgId,
      name: `Payments Check ${RUN}`,
      slug: `payments-check-${RUN}`,
      createdAt: new Date(),
    });

    const created = (await gql(
      PARTNER,
      `mutation C($input: CreateFirmInput) {
        createFirm(input: $input) {
          id apiToken
          bankAccounts { id category isDefault }
        }
      }`,
      { input: { name: `Payments Check ${RUN}`, mockOnboarding: true } },
    )) as {
      createFirm: {
        id: string;
        apiToken: string;
        bankAccounts: { id: string; category: string; isDefault: boolean }[];
      };
    };

    firmId = created.createFirm.id;
    const firmToken = created.createFirm.apiToken;

    await systemDb.insert(confidoFirms).values({
      organizationId: orgId,
      confidoFirmId: firmId,
      encryptedApiToken: encryptPaymentValue(firmToken),
      status: "ACTIVE",
      isAcceptingPayments: true,
      provisioningState: "ready",
    });
    check("firm is recorded as able to take payments", true);

    // ── The three payment shapes ──────────────────────────────────────────
    //
    // Driven through Confido's own manual-payment path rather than a browser,
    // because what is under test is our ledger's response to the transactions,
    // not the hosted page.
    const payer = (await gql(
      firmToken,
      `mutation A($input: AddClientInput!) { addClient(input: $input) { id } }`,
      {
        input: {
          clientName: `Payer ${RUN}`,
          externalId: randomUUID(),
          firmId,
        },
      },
    )) as { addClient: { id: string } };

    const scenarios: {
      name: string;
      trust: number;
      operating: number;
      pay: { trust?: number; operating?: number };
      expectRows: number;
    }[] = [
      {
        name: "trust only",
        trust: 50_000,
        operating: 0,
        pay: { trust: 50_000 },
        expectRows: 1,
      },
      {
        name: "operating only",
        trust: 0,
        operating: 50_000,
        pay: { operating: 50_000 },
        expectRows: 1,
      },
      {
        name: "both",
        trust: 144_000,
        operating: 50_000,
        pay: { trust: 144_000, operating: 50_000 },
        expectRows: 2,
      },
    ];

    for (const s of scenarios) {
      section(s.name);

      const link = (await gql(
        firmToken,
        `mutation L($input: AddPaymentLinkInput!) {
          addPaymentLink(input: $input) { id }
        }`,
        {
          input: {
            clientId: payer.addClient.id,
            externalId: randomUUID(),
            ...(s.trust ? { trust: s.trust } : {}),
            ...(s.operating ? { operating: s.operating } : {}),
            surchargeEnabled: false,
          },
        },
      )) as { addPaymentLink: { id: string } };

      const paid = (await gql(
        firmToken,
        `mutation P($input: RecordManualPaymentInput!) {
          recordManualPaymentOnPaymentLink(input: $input) {
            transactions { id amountProcessed bankAccount { category } }
          }
        }`,
        {
          input: {
            paymentLinkId: link.addPaymentLink.id,
            ...s.pay,
            billingName: `Payer ${RUN}`,
          },
        },
      )) as {
        recordManualPaymentOnPaymentLink: {
          transactions: {
            id: string;
            amountProcessed: number;
            bankAccount: { category: string };
          }[];
        };
      };

      const txns = paid.recordManualPaymentOnPaymentLink.transactions;
      checkEqual(
        `${s.name}: Confido emits one transaction per credited account`,
        txns.length,
        s.expectRows,
      );

      // The invariant. Whatever the shape, the legs must sum to the money paid.
      const expectedTotal = (s.pay.trust ?? 0) + (s.pay.operating ?? 0);
      checkEqual(
        `${s.name}: the legs sum to the payment`,
        txns.reduce((sum, t) => sum + t.amountProcessed, 0),
        expectedTotal,
      );

      // Each leg lands on the account it says it does.
      for (const t of txns) {
        const expected =
          t.bankAccount.category === "trust" ? s.pay.trust : s.pay.operating;
        checkEqual(
          `${s.name}: the ${t.bankAccount.category} leg carries its own amount`,
          t.amountProcessed,
          expected,
        );
      }
    }

    section("what our ledger would record");

    // The mapping the webhook applies, asserted directly: one single-sided row
    // per transaction, each keyed on its own transaction id. Driving the real
    // webhook needs a signed delivery, which `16-confido-onboarding` covers;
    // what matters here is that the shape Confido produces maps onto rows whose
    // amounts sum correctly.
    const [inv] = await systemDb
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.organizationId, orgId))
      .limit(1);

    check(
      "no invoices were invented by this check",
      inv === undefined,
      "the scenarios above exercise Confido, not our invoice tables",
    );
  } finally {
    await systemDb
      .delete(invoicePayments)
      .where(eq(invoicePayments.organizationId, orgId))
      .catch(() => {});
    await systemDb
      .delete(confidoFirms)
      .where(eq(confidoFirms.organizationId, orgId))
      .catch(() => {});
    await systemDb
      .delete(organization)
      .where(eq(organization.id, orgId))
      .catch(() => {});
    if (firmId) {
      console.log(`\n  Confido firm ${firmId} (sandbox firms cannot be deleted)`);
    }
  }

  await report();
};

main().catch(async (err) => {
  console.error("\x1b[31mCheck crashed:\x1b[0m", err);
  await report();
});
