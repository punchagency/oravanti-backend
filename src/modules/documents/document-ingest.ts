import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db/client";
import {
  documentCaseLinks,
  documents,
  documentVersions,
} from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";

/**
 * SHA-256 of the file bytes. This is the AI analysis cache key — identical
 * bytes anywhere in the system resolve to one `document_analyses` row, so a
 * re-upload of an unchanged file costs no Document AI / Gemini spend. A null
 * checksum silently disables caching, so it is computed at ingest time and
 * never left to a backfill.
 */
export const computeChecksum = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

export type IngestDocumentInput = {
  organizationId: string;
  /** Storage object key; the bytes must already be uploaded. */
  storagePath: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
  title?: string;
  category?: "application" | "supporting" | "identity" | "uscis_response";
  uploadedByUserId?: string | null;
  createdByUserId?: string | null;
  /** Exactly one of these should be set — it determines the link table used. */
  leadId?: string | null;
  caseId?: string | null;
  linkedByStaffId?: string | null;
};

export type IngestDocumentResult = {
  documentId: string;
  documentVersionId: string;
  versionNumber: number;
};

/**
 * Create a `documents` + `document_versions` pair for an already-uploaded file
 * and link it to a lead or case.
 *
 * Every file entering the system goes through here, so questionnaire uploads,
 * staff uploads and external submissions all produce the same shape — one
 * document identity, versioned, checksummed, and reachable through the link
 * tables. Callers must run this inside a transaction.
 */
export const ingestDocument = async (
  input: IngestDocumentInput,
): Promise<IngestDocumentResult> => {
  const [document] = await db
    .insert(documents)
    .values({
      title: input.title ?? input.originalFileName,
      category: input.category,
      createdByUserId: input.createdByUserId ?? input.uploadedByUserId ?? null,
    })
    .returning();

  const [version] = await db
    .insert(documentVersions)
    .values({
      documentId: document.id,
      filePath: input.storagePath,
      fileUrl: input.storagePath,
      originalFileName: input.originalFileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      checksum: input.checksum,
      versionNumber: 1,
      uploadedByUserId: input.uploadedByUserId ?? null,
      // Not run through antivirus on this path yet; AI review is queued
      // separately by the scenario-level producer.
      virusScanStatus: "SKIPPED",
      aiScanStatus: "pending",
    })
    .returning();

  await db
    .update(documents)
    .set({ currentVersionId: version.id, updatedAt: new Date() })
    .where(eq(documents.id, document.id));

  if (input.leadId) {
    await db.insert(leadDocumentLinks).values({
      documentId: document.id,
      leadId: input.leadId,
      linkedByStaffId: input.linkedByStaffId ?? null,
    });
  }

  if (input.caseId) {
    await db.insert(documentCaseLinks).values({
      documentId: document.id,
      caseId: input.caseId,
      linkedByUserId: input.uploadedByUserId ?? null,
    });
  }

  return {
    documentId: document.id,
    documentVersionId: version.id,
    versionNumber: version.versionNumber,
  };
};

/**
 * Append a new version to an existing document.
 *
 * Used when a client re-answers a `file_upload` question: the requirement and
 * the document identity are unchanged, only the bytes are new. Keeping this as
 * a version bump (rather than a fresh document) is what makes "re-uploaded ⇒
 * re-run the AI" fall out for free — the new version carries a new checksum,
 * which misses the analysis cache, while the old version's history survives.
 */
export const addDocumentVersion = async (
  documentId: string,
  input: Omit<IngestDocumentInput, "leadId" | "caseId" | "linkedByStaffId">,
): Promise<IngestDocumentResult> => {
  const [latest] = await db
    .select({ versionNumber: documentVersions.versionNumber })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNumber))
    .limit(1);

  const nextVersion = (latest?.versionNumber ?? 0) + 1;

  const [version] = await db
    .insert(documentVersions)
    .values({
      documentId,
      filePath: input.storagePath,
      fileUrl: input.storagePath,
      originalFileName: input.originalFileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      checksum: input.checksum,
      versionNumber: nextVersion,
      uploadedByUserId: input.uploadedByUserId ?? null,
      virusScanStatus: "SKIPPED",
      aiScanStatus: "pending",
    })
    .returning();

  await db
    .update(documents)
    .set({ currentVersionId: version.id, updatedAt: new Date() })
    .where(eq(documents.id, documentId));

  return {
    documentId,
    documentVersionId: version.id,
    versionNumber: version.versionNumber,
  };
};

/**
 * Re-link a lead's documents onto the case it converted into.
 *
 * Replaces the previous copy-into-new-`documents`-rows behaviour: copying
 * minted a second identity for the same bytes, which broke checksum/analysis
 * continuity and stranded any AI findings or resolved issues attached to the
 * lead-stage document at exactly the moment the firm cares most.
 */
export const relinkLeadDocumentsToCase = async (
  leadId: string,
  caseId: string,
  linkedByUserId?: string | null,
): Promise<number> => {
  const links = await db
    .select({ documentId: leadDocumentLinks.documentId })
    .from(leadDocumentLinks)
    .where(
      and(
        eq(leadDocumentLinks.leadId, leadId),
        isNull(leadDocumentLinks.archivedAt),
      ),
    );

  if (links.length === 0) return 0;

  await db
    .insert(documentCaseLinks)
    .values(
      links.map((link) => ({
        documentId: link.documentId,
        caseId,
        linkedByUserId: linkedByUserId ?? null,
      })),
    )
    .onConflictDoNothing();

  return links.length;
};
