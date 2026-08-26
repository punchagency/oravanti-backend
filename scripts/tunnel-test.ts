/**
 * End-to-end webhook test scaffolding.
 *
 * Not a check: it needs a public tunnel, a browser and a human, so it cannot
 * run unattended. Kept because that combination is the only way to exercise the
 * one seam nothing else reaches — a real signed delivery from Confido producing
 * real ledger rows.
 *
 *   npx tsx scripts/tunnel-test.ts setup    # build a payable invoice, print the link
 *   npx tsx scripts/tunnel-test.ts verify   # show what landed in the ledger
 *
 * Runs against the DEV database deliberately: the point is to watch the real
 * running API and worker handle a real signed delivery, and both are pointed at
 * dev. Everything it creates is prefixed `tunnel-test-` so it can be found.
 *
 * Setup, before `setup`:
 *
 *   1. `ngrok http 3000 --domain=<your-static-domain>`
 *   2. Point the Confido webhook URL at `https://<domain>/webhooks/confido`,
 *      enabled, with the secret matching CONFIDO_WEBHOOK_SECRET. The path
 *      matters — a bare domain 404s every delivery and Confido disables the URL
 *      after 24 hours of failures.
 *   3. `npm run dev` and `npm run worker:dev`. If the ledger stays empty after
 *      paying, check `npx tsx scripts/q-inspect.ts` first: a worker that has
 *      stopped consuming looks entirely healthy from the outside.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { systemDb } from "../src/db/client";
import { organization } from "../src/db/schema/auth-schema";
import { confidoFirms } from "../src/db/schema/confido-firms";
import { invoiceLineItems, invoices } from "../src/db/schema/invoices";
import { invoicePayments } from "../src/db/schema/invoice-payments";
import { practiceAreas } from "../src/db/schema/practice-areas";
import { leads } from "../src/db/schema/leads";
import { encryptPaymentValue } from "../src/utils/payment-crypto";
import { mintPaymentLink, startCheckout } from "../src/modules/finance/payment-links.service";

const TAG = "tunnel-test";
const API = process.env.CONFIDO_API_URL ?? "https://api.sandbox.gravity-legal.com/v2";

const gql = async (token: string, query: string, variables = {}) => {
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
};

const setup = async () => {
  const run = randomUUID().slice(0, 8);
  const orgId = `${TAG}-${run}`;

  await systemDb.insert(organization).values({
    id: orgId,
    name: `Tunnel Test ${run}`,
    slug: `${TAG}-${run}`,
    createdAt: new Date(),
  });

  const created = await gql(process.env.CONFIDO_PARTNER_TOKEN!, `
    mutation C($input: CreateFirmInput) {
      createFirm(input: $input) { id apiToken }
    }`, { input: { name: `Tunnel Test ${run}`, mockOnboarding: true } });

  const firmId = created.createFirm.id as string;
  const firmToken = created.createFirm.apiToken as string;

  await systemDb.insert(confidoFirms).values({
    organizationId: orgId,
    confidoFirmId: firmId,
    encryptedApiToken: encryptPaymentValue(firmToken),
    status: "ACTIVE",
    isAcceptingPayments: true,
    provisioningState: "ready",
  });

  // A lead to bill, so this exercises the lead-billed path that consultation
  // invoices use — the harder of the two, since no client row exists.
  const [area] = await systemDb.select({ id: practiceAreas.id }).from(practiceAreas).limit(1);
  // `leads.practice_area_id` is NOT NULL, and an invoice raised against a lead
  // with no practice area is refused by validation anyway — so an empty
  // catalogue is a broken environment, not a case to paper over with a null.
  if (!area) {
    throw new Error(
      "No practice areas in the catalogue — seed one before running the tunnel test",
    );
  }
  const [lead] = await systemDb.insert(leads).values({
    organizationId: orgId,
    firstName: "Tunnel",
    lastName: `Test ${run}`,
    email: `tunnel+${run}@example.com`,
    source: "direct",
    practiceAreaId: area.id,
  }).returning({ id: leads.id });

  // Split invoice: a filing fee to trust, attorney time to operating. This is
  // the shape that produces TWO transactions and therefore two ledger rows.
  const [invoice] = await systemDb.insert(invoices).values({
    organizationId: orgId,
    invoiceNumber: `TUNNEL-${run}`,
    leadId: lead!.id,
    practiceAreaId: area?.id ?? null,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
    status: "sent",
    subtotalOperating: "150.0000",
    subtotalTrust: "50.0000",
    totalAmount: "200.0000",
  }).returning({ id: invoices.id });

  await systemDb.insert(invoiceLineItems).values([
    { organizationId: orgId, invoiceId: invoice!.id, description: "Filing fee", quantity: "1", rate: "50.0000", amount: "50.0000", account: "trust_iolta" },
    { organizationId: orgId, invoiceId: invoice!.id, description: "Attorney time", quantity: "1", rate: "150.0000", amount: "150.0000", account: "operating" },
  ]);

  const token = await mintPaymentLink(orgId, invoice!.id);
  const session = await startCheckout(token);

  console.log(`
  organization : ${orgId}
  confido firm : ${firmId}
  invoice      : TUNNEL-${run}  ($50 trust + $150 operating = $200)

  PAY HERE:
  ${session.url}

  Then:  npx tsx scripts/tunnel-test.ts verify
`);
};

const verify = async () => {
  const orgs = await systemDb
    .select({ id: organization.id })
    .from(organization);
  const testOrgs = orgs.filter((o) => o.id.startsWith(TAG));

  for (const org of testOrgs) {
    const [inv] = await systemDb
      .select({
        id: invoices.id,
        number: invoices.invoiceNumber,
        status: invoices.status,
        total: invoices.totalAmount,
        paid: invoices.amountPaid,
        due: invoices.balanceDue,
      })
      .from(invoices)
      .where(eq(invoices.organizationId, org.id))
      .limit(1);
    if (!inv) continue;

    const rows = await systemDb
      .select()
      .from(invoicePayments)
      .where(and(eq(invoicePayments.organizationId, org.id), eq(invoicePayments.invoiceId, inv.id)));

    console.log(`\n  ${inv.number}  status=${inv.status}  total=${inv.total}  paid=${inv.paid}  due=${inv.due}`);
    if (!rows.length) {
      console.log("    (no ledger rows yet — pay the link, and check the worker is running)");
      continue;
    }
    for (const r of rows) {
      console.log(`    row: amount=${r.amount}  trust=${r.amountTrust}  operating=${r.amountOperating}  method=${r.method}  ref=${r.providerReference?.slice(0, 12)}`);
    }
    const sum = rows.reduce((t, r) => t + Number(r.amount), 0);
    console.log(`    sum(amount) = ${sum.toFixed(2)}  ${sum === Number(inv.paid) ? "== amount_paid ✓" : "!= amount_paid ✗"}`);
  }
};

const mode = process.argv[2] ?? "setup";
(mode === "verify" ? verify() : setup())
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
