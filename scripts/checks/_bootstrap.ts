import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { organization, user } from "../../src/db/schema/auth-schema";
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
  requestContextStore,
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
  requestContextStore.run(
    {
      ipAddress: null,
      userId,
      organizationId,
      staffId: null,
      rawUserDEK: null,
      tenantDb: null,
    },
    async () => {
      await initializeTenantContext();
      return fn();
    },
  );

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

    const [lead] = await systemDb
      .insert(leads)
      .values({
        organizationId,
        firstName: "Check",
        lastName: `Lead ${suffix}`,
        email: `lead-${suffix}@example.test`,
        source: "direct",
      })
      .returning();
    fixture.leadId = lead.id;

    if (spec.withCase) {
      const [area] = await systemDb
        .insert(practiceAreas)
        .values({ name: `Check Immigration ${suffix}` })
        .returning();

      const [subcategory] = await systemDb
        .insert(practiceAreaSubcategories)
        .values({
          practiceAreaId: area.id,
          code: `check-sub-${suffix}`,
          name: `Check Subcategory ${suffix}`,
        })
        .returning();

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

      await systemDb.insert(leadDocumentLinks).values({
        documentId: doc.id,
        leadId: lead.id,
        organizationId,
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
      await systemDb
        .delete(practiceAreaCaseTypes)
        .where(eq(practiceAreaCaseTypes.id, c.caseTypeId));
      await systemDb
        .delete(practiceAreaSubcategories)
        .where(eq(practiceAreaSubcategories.id, c.subcategoryId));
      await systemDb
        .delete(practiceAreas)
        .where(eq(practiceAreas.id, c.practiceAreaId));
    }
    if (fixture.leadId) {
      await systemDb.delete(leads).where(eq(leads.id, fixture.leadId));
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
