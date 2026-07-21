import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { documentAnalyses } from "../../db/schema/document-analyses";
import {
  documentCaseLinks,
  documents,
  documentVersions,
} from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import { leads } from "../../db/schema/leads";
import { getFirmLanguage } from "../settings/consultation/consultation-settings.service";
import {
  AI_SCHEMA_VERSION,
  type AiScanDocument,
  type AiScanRequestJob,
} from "./contract";
import {
  AI_MODEL_VERSION,
  DOCUMENT_TYPE_SLUGS,
  effectivePromptVersion,
} from "./vocabulary";

// The AI service can only OCR these; other formats are skipped rather than sent.
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "application/pdf",
]);

export type ScenarioType = "lead" | "case";

type DocRow = {
  id: string;
  versionId: string | null;
  checksum: string | null;
  storagePath: string | null;
  mimeType: string | null;
};

/** A DocRow with every field present — the only kind we can actually scan. */
type ScannableDoc = {
  id: string;
  versionId: string;
  checksum: string;
  storagePath: string;
  mimeType: string;
};

const scenarioDocuments = async (
  scenarioType: ScenarioType,
  scenarioId: string,
): Promise<DocRow[]> => {
  const cols = {
    id: documents.id,
    versionId: documentVersions.id,
    checksum: documentVersions.checksum,
    storagePath: documentVersions.filePath,
    mimeType: documentVersions.mimeType,
  };
  if (scenarioType === "lead") {
    return db
      .select(cols)
      .from(leadDocumentLinks)
      .innerJoin(documents, eq(documents.id, leadDocumentLinks.documentId))
      .innerJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
      )
      .where(
        and(
          eq(leadDocumentLinks.leadId, scenarioId),
          isNull(leadDocumentLinks.archivedAt),
          eq(documents.status, "active"),
        ),
      );
  }
  return db
    .select(cols)
    .from(documentCaseLinks)
    .innerJoin(documents, eq(documents.id, documentCaseLinks.documentId))
    .innerJoin(
      documentVersions,
      eq(documentVersions.id, documents.currentVersionId),
    )
    .where(
      and(
        eq(documentCaseLinks.caseId, scenarioId),
        isNull(documentCaseLinks.archivedAt),
        eq(documents.status, "active"),
      ),
    );
};

/** The scenario's own known identity values — another participant in cross-ref. */
const expectedValues = async (
  scenarioType: ScenarioType,
  scenarioId: string,
): Promise<Record<string, string>> => {
  const build = (
    firstName?: string | null,
    lastName?: string | null,
    email?: string | null,
    phone?: string | null,
  ) => {
    const out: Record<string, string> = {};
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (name) out.full_name = name;
    if (email) out.email = email;
    if (phone) out.phone = phone;
    return out;
  };

  if (scenarioType === "lead") {
    const [lead] = await db
      .select({
        firstName: leads.firstName,
        lastName: leads.lastName,
        email: leads.email,
        phone: leads.phone,
      })
      .from(leads)
      .where(eq(leads.id, scenarioId))
      .limit(1);
    return lead ? build(lead.firstName, lead.lastName, lead.email, lead.phone) : {};
  }

  const [row] = await db
    .select({
      firstName: clients.firstName,
      lastName: clients.lastName,
      email: clients.email,
      phone: clients.phone,
    })
    .from(cases)
    .innerJoin(clients, eq(clients.id, cases.clientId))
    .where(eq(cases.id, scenarioId))
    .limit(1);
  return row ? build(row.firstName, row.lastName, row.email, row.phone) : {};
};

export type BuiltScanRequest = {
  payload: AiScanRequestJob;
  documentCount: number;
  cachedCount: number;
};

/**
 * Assemble the scan request for a scenario: resolve its documents, attach any
 * cached facts from `document_analyses` (so the worker only re-extracts what
 * changed), and include the scenario's own values for cross-referencing.
 *
 * Returns null when there are no scannable documents — the caller should not
 * enqueue an empty scan.
 */
export const buildScanRequest = async (params: {
  organizationId: string;
  scenarioType: ScenarioType;
  scenarioId: string;
  jobId: string;
}): Promise<BuiltScanRequest | null> => {
  const { organizationId, scenarioType, scenarioId, jobId } = params;

  const rows = await scenarioDocuments(scenarioType, scenarioId);
  // A null checksum means caching/verification is impossible; an unsupported
  // mime type can't be OCR'd. Skip both rather than enqueue a doomed document.
  const scannable = rows.filter(
    (r): r is ScannableDoc =>
      !!r.versionId &&
      !!r.checksum &&
      !!r.storagePath &&
      !!r.mimeType &&
      SUPPORTED_MIME_TYPES.has(r.mimeType),
  );
  if (scannable.length === 0) return null;

  const promptVersion = effectivePromptVersion(DOCUMENT_TYPE_SLUGS);
  const modelVersion = AI_MODEL_VERSION;

  const checksums = [...new Set(scannable.map((r) => r.checksum))];
  const analyses = await db
    .select()
    .from(documentAnalyses)
    .where(
      and(
        inArray(documentAnalyses.checksum, checksums),
        eq(documentAnalyses.promptVersion, promptVersion),
        eq(documentAnalyses.modelVersion, modelVersion),
        eq(documentAnalyses.status, "complete"),
      ),
    );
  const analysisByChecksum = new Map(analyses.map((a) => [a.checksum, a]));

  let cachedCount = 0;
  const documentsPayload: AiScanDocument[] = scannable.map((r) => {
    const a = analysisByChecksum.get(r.checksum);
    if (a) cachedCount += 1;
    return {
      id: r.id,
      version_id: r.versionId,
      checksum: r.checksum,
      storage_path: r.storagePath,
      mime_type: r.mimeType,
      cached_facts: a
        ? {
            // id is this scenario's document id, so results map back correctly —
            // not whatever id produced the (checksum-shared) cached analysis.
            id: r.id,
            checksum: r.checksum,
            document_type: a.documentTypeSlug ?? "other",
            extracted_fields:
              (a.extractedFields as Record<string, string>) ?? {},
            has_photo: a.hasPhoto,
            authenticity: {
              verdict: a.authenticityVerdict ?? "indeterminate",
              confidence: Number(a.authenticityConfidence ?? 0),
            },
            ocr_artifact_key: a.ocrArtifactKey,
          }
        : null,
    };
  });

  const [language, expected] = await Promise.all([
    getFirmLanguage(organizationId),
    expectedValues(scenarioType, scenarioId),
  ]);

  const payload: AiScanRequestJob = {
    schema_version: AI_SCHEMA_VERSION,
    job_id: jobId,
    organization_id: organizationId,
    language,
    prompt_version: promptVersion,
    model_version: modelVersion,
    allowed_slugs: [...DOCUMENT_TYPE_SLUGS],
    documents: documentsPayload,
    expected_values: expected,
    options: { cross_check: true, photo_compare: true },
  };

  return { payload, documentCount: documentsPayload.length, cachedCount };
};
