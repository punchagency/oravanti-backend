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
import { eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { caseIssueEvents, caseIssues } from "../../src/db/schema/case-issues";
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
  "leads",
  "cases",
  "clients",
  "case_issues",
  "case_issue_documents",
  "case_issue_events",
  "ai_scan_jobs",
  "invoices",
  "invoice_line_items",
  "invoice_payments",
  "invoice_followups",
  "finance_events",
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
    "case_issue_events",
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

    await systemDb.insert(caseIssueEvents).values({
      issueId: issue.id,
      toStatus: "open",
    });

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
        await sql`SELECT count(*)::int AS n FROM case_issue_events WHERE issue_id = ${issue.id}`;
      checkEqual("the owning tenant sees the issue's events", ownEvents[0].n, 1);

      // ── Another tenant sees nothing ─────────────────────────────────────
      await sql.unsafe(`SET app.current_organization_id = 'some-other-org'`);

      const other = await sql`SELECT count(*)::int AS n FROM case_issues WHERE id = ${issue.id}`;
      checkEqual("another tenant cannot see the issue", other[0].n, 0);

      const otherEvents =
        await sql`SELECT count(*)::int AS n FROM case_issue_events WHERE issue_id = ${issue.id}`;
      checkEqual(
        "another tenant cannot see the events (inherited scope)",
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

      // ── No context set at all ───────────────────────────────────────────
      await sql.unsafe(`RESET app.current_organization_id`);
      const noCtx = await sql`SELECT count(*)::int AS n FROM case_issues WHERE id = ${issue.id}`;
      checkEqual("with no tenant context, nothing is visible", noCtx[0].n, 0);
    } finally {
      await sql.end();
      await systemDb.delete(caseIssues).where(eq(caseIssues.id, issue.id));
    }
  });

  await report();
};

void main();
