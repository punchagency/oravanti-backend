import { randomUUID } from "crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { emailService } from "../../src/utils/email/email.service";
import { organization, user } from "../../src/db/schema/auth-schema";
import { auditEvents } from "../../src/db/schema/audit-events";
import { caseIssues } from "../../src/db/schema/case-issues";
import { cases } from "../../src/db/schema/cases";
import { clients } from "../../src/db/schema/clients";
import { practiceAreaCaseTypes } from "../../src/db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../src/db/schema/practice-area-subcategories";
import { practiceAreas } from "../../src/db/schema/practice-areas";
import { documentAnalyses } from "../../src/db/schema/document-analyses";
import { documents, documentVersions } from "../../src/db/schema/documents";
import { leadDocumentLinks } from "../../src/db/schema/lead-document-links";
import { leads } from "../../src/db/schema/leads";
import {
  notificationPreferences,
  notificationSettings,
} from "../../src/db/schema/notification-settings";
import { notifications } from "../../src/db/schema/notifications";
import { staff } from "../../src/db/schema/staff";
import {
  initializeTenantContext,
  runWithRequestContext,
} from "../../src/middleware/request-context";
import {
  AI_MODEL_VERSION,
  effectivePromptVersion,
} from "../../src/modules/ai-scan/vocabulary";

// ─── Reporting ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

export const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
    if (detail !== undefined) {
      console.log(`       ${JSON.stringify(detail)}`);
    }
  }
};

export const checkEqual = <T>(label: string, actual: T, expected: T) =>
  check(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });

export const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** Prints the tally and exits non-zero when anything failed. */
export const report = async () => {
  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
  }
  await closeDb().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
};

// ─── RLS context ─────────────────────────────────────────────────────────────

/**
 * Runs `fn` inside an AsyncLocalStorage request context bound to a tenant
 * connection, mirroring what `requestContextMiddleware` + `resolveActorContext`
 * do for an HTTP request.
 *
 * This matters: `src/db/client.ts` exports `db` as a Proxy that only routes to a
 * tenant connection when a context with `tenantDb` is active, and otherwise
 * falls back to `systemDb` — which bypasses RLS entirely. A check that queried
 * `db` outside a context would silently exercise the wrong connection and pass
 * for the wrong reason.
 */
export const withOrgContext = async <T>(
  organizationId: string,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> =>
  runWithRequestContext(
    // Built through the exported helper rather than as an object literal:
    // RequestContext has grown requestId, source, actorType and four more
    // fields since this was written, and a literal silently rots each time
    // another is added. The helper fills in the rest and stays correct.
    { source: "cli", userId, organizationId },
    async () => {
      await initializeTenantContext();
      return fn();
    },
  );

// ─── Email ───────────────────────────────────────────────────────────────────

export type CapturedEmail = { to: string; subject: string };

const captured: CapturedEmail[] = [];

/** What `silenceEmail` intercepted, in order. */
export const capturedEmails = (): readonly CapturedEmail[] => captured;

/**
 * Roughly what a transport will accept. One address, an `@`, a dotted domain.
 *
 * Not RFC 5322 — it does not need to be. It needs to agree with nodemailer on
 * the two cases the checks actually use: a normal address, and the deliberately
 * malformed one they use to force a delivery failure.
 */
const looksDeliverable = (to: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());

/**
 * Stop checks from sending real email.
 *
 * These run against a real service layer, so `sendInvoice` and `sendFollowUp`
 * reach a live SMTP transport — which means a check run either fails noisily
 * against fixture addresses or, worse, succeeds and posts test mail to whoever
 * owns the mailbox. Neither is something a check should do as a side effect of
 * asserting ledger behaviour.
 *
 * Deliberately NOT a blanket no-op. A malformed recipient still throws, because
 * the delivery-failure path is one of the things under test: an invoice whose
 * send fails must stay a draft with the reason recorded. Swallowing that would
 * turn three real assertions into ones that cannot fail.
 *
 * Patches the singleton's own method rather than the class, so every caller —
 * deliveries, follow-ups, anything reaching `emailService.sendEmail` — is
 * covered by one call, and nothing in `src/` has to know about it.
 */
export const silenceEmail = (): void => {
  captured.length = 0;
  emailService.sendEmail = async (options) => {
    if (!looksDeliverable(options.to)) {
      // The wording nodemailer uses, so a check asserting on the reason keeps
      // asserting on the same string.
      throw new Error("No recipients defined");
    }
    captured.push({ to: options.to, subject: options.subject });
    // Null rather than a synthetic id: nothing was handed to a provider, so
    // there is no id a delivery callback could ever reference. The type is
    // nullable for exactly this case.
    return { providerMessageId: null };
  };
};

// ─── Issue audit trail ───────────────────────────────────────────────────────

/**
 * The audit rows one case issue has accumulated, oldest first.
 *
 * Replaces the direct `case_issue_events` reads these checks used to do. That
 * table is gone — its trail lives in `audit_events` under the
 * `case_review.issue_*` actions — and because scripts/ was outside the
 * typecheck config, the dead import survived here as `undefined` and every
 * check that touched it failed at runtime instead of at build time.
 *
 * Reads through `systemDb`: a check asserting that a trail was written must
 * not also depend on the reader's RLS policy letting it back out.
 */
export const issueAuditEvents = (issueId: string) =>
  systemDb
    .select({
      action: auditEvents.action,
      summary: auditEvents.summary,
      metadata: auditEvents.metadata,
      actorStaffId: auditEvents.actorStaffId,
      occurredAt: auditEvents.occurredAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, "case_issue"),
        eq(auditEvents.entityId, issueId),
      ),
    )
    .orderBy(asc(auditEvents.occurredAt));

/** The `toStatus` an issue audit row carries in its metadata, when it has one. */
export const toStatusOf = (row: { metadata: unknown }): string | null =>
  (row.metadata as { toStatus?: string } | null)?.toStatus ?? null;

/** The `fromStatus` an issue audit row carries in its metadata, when it has one. */
export const fromStatusOf = (row: { metadata: unknown }): string | null =>
  (row.metadata as { fromStatus?: string } | null)?.fromStatus ?? null;

// ─── Fixtures ────────────────────────────────────────────────────────────────

export type DocumentSpec = {
  title: string;
  /** Populates document_analyses so the document contributes facts. */
  analysis?: {
    documentTypeSlug: string;
    extractedFields: Record<string, string>;
    hasPhoto?: boolean;
    authenticityVerdict?: "genuine" | "suspect" | "indeterminate";
    authenticityConfidence?: number;
  };
};

/**
 * An optional converted-case scenario, seeded alongside the lead.
 *
 * Cases sit behind a chain of required foreign keys (client, practice area,
 * subcategory, case type) that the test database does not carry any seed data
 * for, so the whole chain is created and torn down per run.
 */
export type CaseFixture = {
  caseId: string;
  caseNumber: string;
  clientId: string;
  clientName: string;
  caseTypeId: string;
  caseTypeName: string;
  practiceAreaId: string;
  subcategoryId: string;
};

export type Fixture = {
  organizationId: string;
  userId: string;
  leadId: string;
  /** Staff member used as actor for case opening and issue resolution. */
  staffId: string;
  staffName: string;
  /**
   * The catalogue chain the lead points at. Always seeded — both
   * `leads.practice_area_id` and `leads.case_type_id` are NOT NULL, and a case
   * type reaches its practice area only through a subcategory — and reused by
   * the case chain when the spec asks for one.
   */
  practiceAreaId: string;
  subcategoryId: string;
  caseTypeId: string;
  /** documentId + versionId + checksum, in the order given by the spec. */
  docs: { id: string; versionId: string; checksum: string; title: string }[];
  /** Present only when the spec asked for a case. */
  case?: CaseFixture;
};

/**
 * Seeds a throwaway organization plus a lead scenario and its documents, runs
 * `fn`, then removes everything in a `finally`.
 *
 * Seeding and teardown deliberately use `systemDb`: fixtures span tables that
 * RLS would hide (and the org does not exist yet when seeding starts). The
 * body under test runs through `withOrgContext`, so only the setup/teardown
 * bypass is unscoped — and it is bounded to ids this function created.
 */
export const withTempFixture = async <T>(
  spec: { docs?: DocumentSpec[]; withCase?: boolean },
  fn: (fixture: Fixture) => Promise<T>,
): Promise<T> => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `check-org-${suffix}`;
  const userId = `check-user-${suffix}`;
  const now = new Date();

  const fixture: Fixture = {
    organizationId,
    userId,
    leadId: "",
    staffId: "",
    staffName: "",
    practiceAreaId: "",
    subcategoryId: "",
    caseTypeId: "",
    docs: [],
  };

  try {
    await systemDb.insert(user).values({
      id: userId,
      name: `Check User ${suffix}`,
      email: `check-${suffix}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    await systemDb.insert(organization).values({
      id: organizationId,
      name: `Check Org ${suffix}`,
      slug: `check-org-${suffix}`,
      createdAt: now,
    });

    // Always seeded: cases require an opener, and the resolution log renders
    // the resolving staff member's name and role.
    const [staffRow] = await systemDb
      .insert(staff)
      .values({
        organizationId,
        userId,
        firstName: "Check",
        lastName: `Staff ${suffix}`,
        email: `staff-${suffix}@example.test`,
        role: "paralegal",
      })
      .returning();
    fixture.staffId = staffRow.id;
    fixture.staffName = `Check Staff ${suffix}`;

    // Created before the lead, and unconditionally: `leads.practice_area_id` is
    // NOT NULL. It used to be raised only for `withCase` fixtures, which was
    // enough while a lead could exist without one.
    //
    // `practice_areas` is a GLOBAL catalogue rather than org-scoped, so this is
    // a real row in the shared table and the teardown below removes it.
    const [area] = await systemDb
      .insert(practiceAreas)
      .values({ name: `Check Immigration ${suffix}` })
      .returning();
    fixture.practiceAreaId = area.id;

    // The rest of the chain, for the same reason and now on the same terms:
    // `leads.case_type_id` is NOT NULL too, and a case type reaches its
    // practice area only through a subcategory — so the lead cannot be seeded
    // until all three rows exist. Built here rather than inside `withCase`,
    // which is where they used to live.
    const [subcategory] = await systemDb
      .insert(practiceAreaSubcategories)
      .values({
        practiceAreaId: area.id,
        code: `check-sub-${suffix}`,
        name: `Check Subcategory ${suffix}`,
      })
      .returning();
    fixture.subcategoryId = subcategory.id;

    const [caseType] = await systemDb
      .insert(practiceAreaCaseTypes)
      .values({
        subcategoryId: subcategory.id,
        code: `check-type-${suffix}`,
        name: "Immigration",
        caseNumberPrefix: "ORV",
        jurisdiction: "federal",
      })
      .returning();
    fixture.caseTypeId = caseType.id;

    const [lead] = await systemDb
      .insert(leads)
      .values({
        organizationId,
        firstName: "Check",
        lastName: `Lead ${suffix}`,
        email: `lead-${suffix}@example.test`,
        source: "direct",
        practiceAreaId: area.id,
        caseTypeId: caseType.id,
      })
      .returning();
    fixture.leadId = lead.id;

    if (spec.withCase) {

      const [client] = await systemDb
        .insert(clients)
        .values({
          organizationId,
          leadId: lead.id,
          firstName: "Check",
          lastName: `Client ${suffix}`,
          displayName: `Check Client ${suffix}`,
          email: `client-${suffix}@example.test`,
        })
        .returning();

      const caseNumber = `ORV-CHECK-${suffix}`;
      const [row] = await systemDb
        .insert(cases)
        .values({
          organizationId,
          caseNumber,
          description: "Check fixture case",
          clientId: client.id,
          leadId: lead.id,
          practiceAreaId: area.id,
          caseTypeId: caseType.id,
          openedById: fixture.staffId,
        })
        .returning();

      fixture.case = {
        caseId: row.id,
        caseNumber,
        clientId: client.id,
        clientName: client.displayName,
        caseTypeId: caseType.id,
        caseTypeName: caseType.name,
        practiceAreaId: area.id,
        subcategoryId: subcategory.id,
      };
    }

    const promptVersion = effectivePromptVersion();

    for (const [i, docSpec] of (spec.docs ?? []).entries()) {
      const checksum = `check-${suffix}-${i}`;
      const [doc] = await systemDb
        .insert(documents)
        .values({ title: docSpec.title, createdByUserId: userId })
        .returning();

      const [version] = await systemDb
        .insert(documentVersions)
        .values({
          documentId: doc.id,
          filePath: `checks/${suffix}/${i}.pdf`,
          originalFileName: `${docSpec.title}.pdf`,
          mimeType: "application/pdf",
          fileSize: 1024,
          checksum,
          versionNumber: 1,
          uploadedByUserId: userId,
          virusScanStatus: "SKIPPED",
        })
        .returning();

      await systemDb
        .update(documents)
        .set({ currentVersionId: version.id })
        .where(eq(documents.id, doc.id));

      // No organizationId: lead_document_links is tenant-scoped through its
      // lead, which is what the parentScoped() factory in rls-tenant.ts expects.
      await systemDb.insert(leadDocumentLinks).values({
        documentId: doc.id,
        leadId: lead.id,
      });

      if (docSpec.analysis) {
        await systemDb.insert(documentAnalyses).values({
          checksum,
          promptVersion,
          modelVersion: AI_MODEL_VERSION,
          status: "complete",
          documentTypeSlug: docSpec.analysis.documentTypeSlug,
          extractedFields: docSpec.analysis.extractedFields,
          hasPhoto: docSpec.analysis.hasPhoto ?? false,
          authenticityVerdict: docSpec.analysis.authenticityVerdict ?? "genuine",
          authenticityConfidence:
            docSpec.analysis.authenticityConfidence != null
              ? String(docSpec.analysis.authenticityConfidence)
              : null,
        });
      }

      fixture.docs.push({
        id: doc.id,
        versionId: version.id,
        checksum,
        title: docSpec.title,
      });
    }

    return await fn(fixture);
  } finally {
    await teardown(fixture);
  }
};

const teardown = async (fixture: Fixture) => {
  const docIds = fixture.docs.map((d) => d.id);
  const checksums = fixture.docs.map((d) => d.checksum);

  try {
    // case_issues cascade to their documents/events; lead cascade covers links.
    await systemDb
      .delete(caseIssues)
      .where(eq(caseIssues.organizationId, fixture.organizationId));

    if (docIds.length) {
      await systemDb
        .delete(leadDocumentLinks)
        .where(inArray(leadDocumentLinks.documentId, docIds));
      await systemDb
        .update(documents)
        .set({ currentVersionId: null })
        .where(inArray(documents.id, docIds));
      await systemDb
        .delete(documentVersions)
        .where(inArray(documentVersions.documentId, docIds));
      await systemDb.delete(documents).where(inArray(documents.id, docIds));
    }
    if (checksums.length) {
      await systemDb
        .delete(documentAnalyses)
        .where(inArray(documentAnalyses.checksum, checksums));
    }
    // The case chain unwinds in FK order: case → client → case type →
    // subcategory → practice area. The lead must outlive the case, which
    // references it.
    if (fixture.case) {
      const c = fixture.case;
      await systemDb.delete(cases).where(eq(cases.id, c.caseId));
      await systemDb.delete(clients).where(eq(clients.id, c.clientId));
    }
    if (fixture.leadId) {
      await systemDb.delete(leads).where(eq(leads.id, fixture.leadId));
    }
    // The taxonomy chain unwinds after everything referencing it, innermost
    // first. Unconditional now that every fixture lead points at all three —
    // it used to be torn down only alongside a case, which was where it used
    // to be created.
    if (fixture.caseTypeId) {
      await systemDb
        .delete(practiceAreaCaseTypes)
        .where(eq(practiceAreaCaseTypes.id, fixture.caseTypeId));
    }
    if (fixture.subcategoryId) {
      await systemDb
        .delete(practiceAreaSubcategories)
        .where(eq(practiceAreaSubcategories.id, fixture.subcategoryId));
    }
    if (fixture.practiceAreaId) {
      await systemDb
        .delete(practiceAreas)
        .where(eq(practiceAreas.id, fixture.practiceAreaId));
    }
    if (fixture.staffId) {
      await systemDb.delete(staff).where(eq(staff.id, fixture.staffId));
    }
    // Notification rows are written by the code under test rather than seeded,
    // so nothing above tracks their ids — they are cleared by organization.
    // Preferences go before settings (cascade would handle it, but the explicit
    // order documents the dependency) and both before the organization they
    // reference.
    await systemDb
      .delete(notifications)
      .where(eq(notifications.organizationId, fixture.organizationId));
    await systemDb
      .delete(notificationPreferences)
      .where(
        eq(notificationPreferences.organizationId, fixture.organizationId),
      );
    await systemDb
      .delete(notificationSettings)
      .where(eq(notificationSettings.organizationId, fixture.organizationId));
    await systemDb
      .delete(organization)
      .where(eq(organization.id, fixture.organizationId));
    await systemDb.delete(user).where(eq(user.id, fixture.userId));
  } catch (err) {
    console.error("\n[teardown] failed — test data may remain:", err);
    console.error(`[teardown] org=${fixture.organizationId}`);
  }
};
