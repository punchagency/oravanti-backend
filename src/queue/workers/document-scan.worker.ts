import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { questionnaireResponseFiles } from "../../db/schema/questionnaires";
import { documentScanProvider } from "../../modules/questionnaires/document-scan.provider";
import { redisConnection } from "../connection";
import { DOCUMENT_SCAN_QUEUE, type DocumentScanJob } from "../queues";

/**
 * Scan a single uploaded questionnaire file and persist the result. Uses the
 * stub provider for now; results are stored on questionnaire_response_files.
 */
export const scanQuestionnaireFile = async (fileId: string): Promise<void> => {
  const [file] = await db
    .select()
    .from(questionnaireResponseFiles)
    .where(eq(questionnaireResponseFiles.id, fileId))
    .limit(1);

  if (!file) return;

  await db
    .update(questionnaireResponseFiles)
    .set({ scanStatus: "scanning" })
    .where(eq(questionnaireResponseFiles.id, fileId));

  try {
    const result = await documentScanProvider.scan({
      fileId: file.id,
      originalFilename: file.originalFilename,
      mimeType: file.mimeType,
      storagePath: file.storagePath,
    });

    await db
      .update(questionnaireResponseFiles)
      .set({
        scanStatus: result.status,
        scanResult: result.findings,
        scannedAt: new Date(),
      })
      .where(eq(questionnaireResponseFiles.id, fileId));
  } catch (err) {
    console.error(`[document-scan] failed for file ${fileId}:`, err);
    await db
      .update(questionnaireResponseFiles)
      .set({ scanStatus: "failed", scannedAt: new Date() })
      .where(eq(questionnaireResponseFiles.id, fileId));
  }
};

export const createDocumentScanWorker = () =>
  new Worker<DocumentScanJob>(
    DOCUMENT_SCAN_QUEUE,
    async (job) => {
      await scanQuestionnaireFile(job.data.fileId);
    },
    { connection: redisConnection },
  );
