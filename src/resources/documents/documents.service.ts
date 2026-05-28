import { and, count, desc, eq } from "drizzle-orm";
import { supabaseAdmin } from "../../config/supabase";
import { clients } from "../../db/schema/clients";
import { documents } from "../../db/schema/documents";
import { ExternalServiceError, NotFoundError } from "../../errors/app-error";
import { staff } from "../../db/schema/staff";
import {
  ExternalServiceError,
  NotFoundError,
} from "../../utils/error/app-error";
import { db } from "./../../db/client";

const BUCKET = "documents";

// ─── Storage Path ─────────────────────────────────────────────────────────────

const buildStoragePath = (
  firmId: string,
  clientId: string,
  caseId: string,
  category: string,
  filename: string,
) => `${firmId}/${clientId}/${caseId}/${category}/${filename}`;

export class DocumentsService {
  // ─── Upload ───────────────────────────────────────────────────────────────────

  uploadDocument = async (
    firmId: string,
    data: {
      clientId: string;
      caseId: string;
      uploadedById: string;
      name: string;
      category: "application" | "supporting" | "identity" | "uscis_response";
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    const ext = data.originalFilename.split(".").pop();
    const safeFilename = `${Date.now()}-${data.name.replace(/\s+/g, "_")}.${ext}`;
    const storagePath = buildStoragePath(
      firmId,
      data.clientId,
      data.caseId,
      data.category,
      safeFilename,
    );

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, data.fileBuffer, {
        contentType: data.mimeType,
        upsert: false,
      });

    if (uploadError) throw new ExternalServiceError(uploadError.message);

    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    const [doc] = await db
      .insert(documents)
      .values({
        firmId,
        clientId: data.clientId,
        caseId: data.caseId,
        uploadedById: data.uploadedById,
        name: data.name,
        category: data.category,
        fileUrl: urlData.publicUrl,
        storagePath,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
      })
      .returning();

    return doc;
  };

  // ─── List ─────────────────────────────────────────────────────────────────────

  getAllDocuments = async (
    firmId: string,
    filters?: {
      search?: string;
      category?: string;
      clientId?: string;
      caseId?: string;
      status?: string;
    },
  ) => {
    const rows = await db
      .select({
        id: documents.id,
        name: documents.name,
        category: documents.category,
        fileUrl: documents.fileUrl,
        fileSize: documents.fileSize,
        mimeType: documents.mimeType,
        status: documents.status,
        aiChecked: documents.aiChecked,
        createdAt: documents.createdAt,
        clientId: clients.id,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
        caseId: documents.caseId,
        uploadedById: documents.uploadedById,
        uploaderFirst: staff.firstName,
        uploaderLast: staff.lastName,
      })
      .from(documents)
      .leftJoin(clients, eq(clients.id, documents.clientId))
      .leftJoin(staff, eq(staff.id, documents.uploadedById))
      .where(eq(documents.firmId, firmId))
      .orderBy(desc(documents.createdAt));

    return rows
      .filter((r) => {
        if (filters?.category && r.category !== filters.category) return false;
        if (filters?.clientId && r.clientId !== filters.clientId) return false;
        if (filters?.caseId && r.caseId !== filters.caseId) return false;
        if (filters?.status && r.status !== filters.status) return false;
        if (filters?.search) {
          const q = filters.search.toLowerCase();
          const matches =
            r.name.toLowerCase().includes(q) ||
            r.clientFirst?.toLowerCase().includes(q) ||
            r.clientLast?.toLowerCase().includes(q);
          if (!matches) return false;
        }
        return true;
      })
      .map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        fileUrl: r.fileUrl,
        fileSize: r.fileSize,
        mimeType: r.mimeType,
        status: r.status,
        aiChecked: r.aiChecked,
        createdAt: r.createdAt,
        caseId: r.caseId,
        client: { id: r.clientId, name: `${r.clientFirst} ${r.clientLast}` },
        uploadedBy: {
          id: r.uploadedById,
          name: `${r.uploaderFirst} ${r.uploaderLast}`,
        },
      }));
  };

  // ─── Stats ────────────────────────────────────────────────────────────────────

  getDocumentStats = async (firmId: string) => {
    const rows = await db
      .select({ category: documents.category, total: count() })
      .from(documents)
      .where(eq(documents.firmId, firmId))
      .groupBy(documents.category);

    const stats: Record<string, number> = {
      application: 0,
      supporting: 0,
      identity: 0,
      uscis_response: 0,
    };

    for (const r of rows) stats[r.category] = Number(r.total);

    return stats;
  };

  // ─── Get One ──────────────────────────────────────────────────────────────────

  getDocumentById = async (id: string, firmId: string) => {
    const [row] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.firmId, firmId)));
    return row ?? null;
  };

  // ─── Update Status ────────────────────────────────────────────────────────────

  updateDocumentStatus = async (
    id: string,
    firmId: string,
    status: "approved" | "review_needed" | "processing",
  ) => {
    const [updated] = await db
      .update(documents)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(documents.id, id), eq(documents.firmId, firmId)))
      .returning();
    return updated;
  };

  // ─── Signed Download URL ──────────────────────────────────────────────────────

  getDownloadUrl = async (id: string, firmId: string) => {
    const doc = await this.getDocumentById(id, firmId);
    if (!doc) throw new NotFoundError("Document not found");

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(doc.storagePath, 60 * 60);

    if (error) throw new ExternalServiceError(error.message);
    return data.signedUrl;
  };

  // ─── Delete ───────────────────────────────────────────────────────────────────

  deleteDocument = async (id: string, firmId: string) => {
    const doc = await this.getDocumentById(id, firmId);
    if (!doc) throw new NotFoundError("Document not found");

    await supabaseAdmin.storage.from(BUCKET).remove([doc.storagePath]);
    await db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.firmId, firmId)));
  };
}
