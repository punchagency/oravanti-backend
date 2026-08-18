/**
 * Tier 1 — Postgres. Proves the RLS policies actually isolate tenants.
 *
 *   npm run check 07-rls
 *
 * This check does NOT use the application's connection, and that is the whole
 * point. Postgres skips row-level security for superusers, for roles with
 * BYPASSRLS, and for a table's owner unless FORCE ROW LEVEL SECURITY is set.
 * `oravanti_admin` is all three, so every policy in `src/db/schema/rls.ts` is
 * inert on the connection the app actually uses — a fact this check reports
 * explicitly rather than hiding.
 *
 * So it connects as `oravanti_rls_probe` (created by `npm run test:db:setup`:
 * NOSUPERUSER, NOBYPASSRLS, not the owner) to demonstrate that the policies
 * themselves are correct, and separately reports whether the normal role is
 * subject to them.
 */
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { auditEvents } from "../../src/db/schema/audit-events";
import { caseIssues } from "../../src/db/schema/case-issues";
import { invoiceLinePresets } from "../../src/db/schema/invoice-line-presets";
import { RLS_PROBE_PASSWORD, RLS_PROBE_USER } from "../test-db/rls-probe";
import { check, checkEqual, report, section, withTempFixture } from "./_bootstrap";

/**
 * Connection URL for the restricted probe role.
 *
 * Derived from `DATABASE_URL`, which the runner has already pointed at the test
 * database — deliberately not from `resolveTestDbTarget()`, whose "test must
 * differ from DATABASE_URL" guard is correct for setup but trips here.
 */
const probeUrl = () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = RLS_PROBE_USER;
  url.password = RLS_PROBE_PASSWORD;
  return url.toString();
};

const TENANT_TABLES = [
  // The audit trail is tenant data too, and the most sensitive of it: one
  // table naming what every other table was used for. It also replaced
  // case_issue_events and finance_events, both of which this list went on
  // naming for months after they were dropped.
  "audit_events",
  "leads",
  "cases",
  "clients",
  "case_issues",
  "case_issue_documents",
  "ai_scan_jobs",
  "invoices",
  "invoice_line_items",
  "invoice_payments",
  "invoice_instalments",
  "invoice_followups",
  "invoice_deliveries",
  "invoice_line_presets",
  "billing_rates",
  "time_entries",
] as const;

const main = async () => {
  section("policy coverage");

  const coverage = await systemDb.execute<{
    relname: string;
    relrowsecurity: boolean;
    policies: number;
  }>(
    `SELECT c.relname,
            c.relrowsecurity,
            (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname)::int AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (${TENANT_TABLES.map((t) => `'${t}'`).join(",")})` as never,
  );

  const rows = coverage as unknown as {
    relname: string;
    relrowsecurity: boolean;
    policies: number;
  }[];

  for (const table of TENANT_TABLES) {
    const row = rows.find((r) => r.relname === table);
    check(`${table}: RLS enabled`, row?.relrowsecurity === true, row);
    check(`${table}: has at least one policy`, (row?.policies ?? 0) > 0, row?.policies);
  }

  section("deny-all audit — restrictive-only tables match nothing");

  // Restrictive policies are AND-ed with permissive ones. A table whose only
  // policies are restrictive grants access to nobody, because Postgres denies
  // by default when no permissive policy matches. Such a table looks protected
  // and is in fact unusable — invisible today only because the app role
  // bypasses RLS entirely.
  const mix = (await systemDb.execute(
    `SELECT tablename,
            count(*) FILTER (WHERE permissive = 'PERMISSIVE')::int  AS permissive,
            count(*) FILTER (WHERE permissive = 'RESTRICTIVE')::int AS restrictive
       FROM pg_policies
      WHERE schemaname = 'public'
      GROUP BY tablename
      ORDER BY tablename` as never,
  )) as unknown as {
    tablename: string;
    permissive: number;
    restrictive: number;
  }[];

  const denyAll = mix.filter((m) => m.permissive === 0 && m.restrictive > 0);
  const mine = new Set([
    "case_issues",
    "case_issue_documents",
    "ai_scan_jobs",
  ]);

  for (const m of mix) {
    console.log(
      `       ${m.tablename.padEnd(24)} permissive=${m.permissive} restrictive=${m.restrictive}`,
    );
  }

  check(
    "no AI case-review table is restrictive-only",
    !denyAll.some((m) => mine.has(m.tablename)),
    denyAll.filter((m) => mine.has(m.tablename)).map((m) => m.tablename),
  );

  const othersDenyAll = denyAll.filter((m) => !mine.has(m.tablename));
  if (othersDenyAll.length) {
    console.log(
      `       \x1b[33mNOTE\x1b[0m restrictive-only elsewhere (deny-all once RLS engages): ` +
        othersDenyAll.map((m) => m.tablename).join(", "),
    );
  }

  section("the application role is exempt from RLS (reported, not asserted)");

  const roleInfo = (await systemDb.execute(
    `SELECT current_user AS usr, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user` as never,
  )) as unknown as { usr: string; rolsuper: boolean; rolbypassrls: boolean }[];

  const role = roleInfo[0];
  console.log(
    `       ${role?.usr}: superuser=${role?.rolsuper} bypassrls=${role?.rolbypassrls}`,
  );
  if (role?.rolsuper || role?.rolbypassrls) {
    console.log(
      "       \x1b[33mNOTE\x1b[0m policies do NOT apply to this role — isolation below is\n" +
        "            demonstrated with a restricted role instead. Production must\n" +
        "            connect as a non-superuser, non-owner role without BYPASSRLS\n" +
        "            for any of this to take effect.",
    );
  }

  section("isolation, verified with a role RLS applies to");

  await withTempFixture({ docs: [] }, async (fx) => {
    // Seed one issue for the fixture org, using the unrestricted connection.
    const [issue] = await systemDb
      .insert(caseIssues)
      .values({
        organizationId: fx.organizationId,
        leadId: fx.leadId,
        issueKey: `rls-check-${fx.organizationId}`,
        contentHash: "hash",
        issueType: "rls_check",
        source: "rule",
        ruleVersion: "1",
        severity: "low",
        templateKey: "rls_check",
      })
      .returning();

    // Stands in for the case_issue_events row this used to write. That table
    // is gone; the trail is an audit_events row, which is org-scoped directly
    // rather than through its parent issue -- so this now asserts the audit
    // trail's own isolation, which is the stronger property.
    await systemDb.insert(auditEvents).values({
      organizationId: fx.organizationId,
      actorType: "system",
      actorName: "rls-check",
      category: "business",
      action: "case_review.issue_detected",
      actionType: "create",
      entityType: "case_issue",
      entityId: issue.id,
      summary: "Issue detected",
      source: "cli",
    });

    const presetIds: string[] = [];
    const sql = postgres(probeUrl(), { max: 1 });
    try {
      const probeRole = await sql`SELECT current_user AS usr`;
      checkEqual("probe connected as the restricted role", probeRole[0].usr, RLS_PROBE_USER);

      // ── The owning tenant sees its row ──────────────────────────────────
      await sql.unsafe(
        `SET app.current_organization_id = '${fx.organizationId}'`,
      );
      const own = await sql`SELECT count(*)::int AS n FROM case_issues WHERE id = ${issue.id}`;
      checkEqual("the owning tenant sees its issue", own[0].n, 1);

      const ownEvents =
        await sql`SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${issue.id}`;
      checkEqual("the owning tenant sees the issue's audit trail", ownEvents[0].n, 1);

      // ── Another tenant sees nothing ─────────────────────────────────────
      await sql.unsafe(`SET app.current_organization_id = 'some-other-org'`);

      const other = await sql`SELECT count(*)::int AS n FROM case_issues WHERE id = ${issue.id}`;
      checkEqual("another tenant cannot see the issue", other[0].n, 0);

      const otherEvents =
        await sql`SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${issue.id}`;
      checkEqual(
        "another tenant cannot see the issue's audit trail",
        otherEvents[0].n,
        0,
      );

      const otherJobs =
        await sql`SELECT count(*)::int AS n FROM ai_scan_jobs WHERE organization_id = ${fx.organizationId}`;
      checkEqual("another tenant cannot see scan jobs", otherJobs[0].n, 0);

      const otherLeads =
        await sql`SELECT count(*)::int AS n FROM leads WHERE id = ${fx.leadId}`;
      checkEqual("another tenant cannot see the lead", otherLeads[0].n, 0);

      // ── Writes are constrained too (WITH CHECK) ─────────────────────────
      let insertRejected = false;
      try {
        await sql`
          INSERT INTO case_issues
            (organization_id, lead_id, issue_key, content_hash, issue_type,
             source, rule_version, severity, template_key)
          VALUES (${fx.organizationId}, ${fx.leadId}, 'rls-forbidden', 'h',
                  'rls_check', 'rule', '1', 'low', 'rls_check')`;
      } catch {
        insertRejected = true;
      }
      check("a cross-tenant insert is rejected by WITH CHECK", insertRejected);

      // ── The shared-catalog table: read admits NULL, write does not ──────
      //
      // invoice_line_presets is the only table here whose using and withCheck
      // clauses differ. Rows with a NULL organization_id ship with the product
      // and belong to every firm; rows with one belong to a single firm. Both
      // halves are asserted, because getting either wrong is silent: a wrong
      // `using` hides the catalog from everybody, a wrong `withCheck` lets any
      // firm mint rows every other firm then sees.
      const [shipped] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: null,
          name: `rls-check-shipped-${fx.organizationId}`,
          account: "operating",
          defaultRate: "10.0000",
        })
        .returning();
      const [owned] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: fx.organizationId,
          name: `rls-check-owned-${fx.organizationId}`,
          account: "operating",
          defaultRate: "20.0000",
        })
        .returning();
      presetIds.push(shipped!.id, owned!.id);

      await sql.unsafe(
        `SET app.current_organization_id = '${fx.organizationId}'`,
      );
      const seesShipped =
        await sql`SELECT count(*)::int AS n FROM invoice_line_presets WHERE id = ${shipped!.id}`;
      checkEqual("a tenant sees the shipped catalog", seesShipped[0].n, 1);
      const seesOwn =
        await sql`SELECT count(*)::int AS n FROM invoice_line_presets WHERE id = ${owned!.id}`;
      checkEqual("and its own presets", seesOwn[0].n, 1);

      await sql.unsafe(`SET app.current_organization_id = 'some-other-org'`);
      const otherSeesShipped =
        await sql`SELECT count(*)::int AS n FROM invoice_line_presets WHERE id = ${shipped!.id}`;
      checkEqual(
        "another tenant sees the shipped catalog too",
        otherSeesShipped[0].n,
        1,
      );
      const otherSeesOwned =
        await sql`SELECT count(*)::int AS n FROM invoice_line_presets WHERE id = ${owned!.id}`;
      checkEqual(
        "but not another firm's presets",
        otherSeesOwned[0].n,
        0,
      );

      let shippedInsertRejected = false;
      try {
        await sql`
          INSERT INTO invoice_line_presets (organization_id, name, account, default_rate)
          VALUES (NULL, 'rls-forbidden-shipped', 'operating', 1)`;
      } catch {
        shippedInsertRejected = true;
      }
      check(
        "no tenant can author a shipped preset",
        shippedInsertRejected,
      );

      // Visible but not writable: the shipped row is readable above, so an
      // UPDATE that reached it would be a genuine cross-tenant write.
      const shippedUpdate = await sql`
        UPDATE invoice_line_presets SET default_rate = 999
         WHERE id = ${shipped!.id} RETURNING id`;
      checkEqual(
        "nor edit one it can see",
        shippedUpdate.length,
        0,
      );

      // ── No context set at all ───────────────────────────────────────────
      await sql.unsafe(`RESET app.current_organization_id`);
      const noCtx = await sql`SELECT count(*)::int AS n FROM case_issues WHERE id = ${issue.id}`;
      checkEqual("with no tenant context, nothing is visible", noCtx[0].n, 0);
    } finally {
      await sql.end();
      await systemDb.delete(caseIssues).where(eq(caseIssues.id, issue.id));
      if (presetIds.length) {
        await systemDb
          .delete(invoiceLinePresets)
          .where(inArray(invoiceLinePresets.id, presetIds));
      }
    }
  });

  await report();
};

void main();
