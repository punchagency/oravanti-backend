import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { supabaseAdmin } from "../../config/supabase";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { documents } from "../../db/schema/documents";
import { staff } from "../../db/schema/staff";
import {
  ExternalServiceError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { db } from "./../../db/client";

const BUCKET = "documents";

// ─── Storage Path ─────────────────────────────────────────────────────────────

const buildStoragePath = (
  organizationId: string,
  clientId: string,
  caseId: string,
  category: string,
  filename: string,
) => `${organizationId}/${clientId}/${caseId}/${category}/${filename}`;

export class DocumentsService {
  // ─── Upload ───────────────────────────────────────────────────────────────────

  uploadDocument = async (
    organizationId: string,
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
      organizationId,
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
        organizationId,
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
    organizationId: string,
    filters?: {
      search?: string;
      category?: string;
      clientId?: string;
      caseId?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
  ) => {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });

    const conditions = [eq(documents.organizationId, organizationId)];

    if (filters?.category) {
      conditions.push(eq(documents.category, filters.category as any));
    }
    if (filters?.clientId) {
      conditions.push(eq(documents.clientId, filters.clientId));
    }
    if (filters?.caseId) {
      conditions.push(eq(documents.caseId, filters.caseId));
    }
    if (filters?.status) {
      conditions.push(eq(documents.status, filters.status as any));
    }
    if (filters?.search) {
      const search = `%${filters.search}%`;
      const searchCondition = or(
        ilike(documents.name, search),
        ilike(clients.firstName, search),
        ilike(clients.lastName, search),
      );

      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(documents)
      .leftJoin(clients, eq(clients.id, documents.clientId))
      .where(where);

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
        caseId: cases.id,
        caseType: cases.caseType,
        uploadedById: documents.uploadedById,
        uploaderFirst: staff.firstName,
        uploaderLast: staff.lastName,
      })
      .from(documents)
      .leftJoin(clients, eq(clients.id, documents.clientId))
      .leftJoin(cases, eq(cases.id, documents.caseId))
      .leftJoin(staff, eq(staff.id, documents.uploadedById))
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .offset(offset);

    return buildPaginatedResponse(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        fileUrl: r.fileUrl,
        fileSize: r.fileSize,
        mimeType: r.mimeType,
        status: r.status,
        aiChecked: r.aiChecked,
        createdAt: r.createdAt,
        case: {
          id: r.caseId,
          caseType: r.caseType,
        },
        client: { id: r.clientId, name: `${r.clientFirst} ${r.clientLast}` },
        uploadedBy: {
          id: r.uploadedById,
          name: `${r.uploaderFirst} ${r.uploaderLast}`,
        },
      })),
      {
        page,
        limit,
        total: Number(total),
      },
    );
  };

  // ─── Stats ────────────────────────────────────────────────────────────────────

  getDocumentStats = async (organizationId: string) => {
    const rows = await db
      .select({ category: documents.category, total: count() })
      .from(documents)
      .where(eq(documents.organizationId, organizationId))
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

  getDocumentById = async (id: string, organizationId: string) => {
    const [row] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.organizationId, organizationId)));
    return row ?? null;
  };

  // ─── Update Status ────────────────────────────────────────────────────────────

  updateDocumentStatus = async (
    id: string,
    organizationId: string,
    status: "approved" | "review_needed" | "processing",
  ) => {
    const [updated] = await db
      .update(documents)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(documents.id, id), eq(documents.organizationId, organizationId)))
      .returning();
    return updated;
  };

  // ─── Signed Download URL ──────────────────────────────────────────────────────

  getDownloadUrl = async (id: string, organizationId: string) => {
    const doc = await this.getDocumentById(id, organizationId);
    if (!doc) throw new NotFoundError("Document not found");

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(doc.storagePath, 60 * 60);

    if (error) throw new ExternalServiceError(error.message);
    return data.signedUrl;
  };

  // ─── Delete ───────────────────────────────────────────────────────────────────

  deleteDocument = async (id: string, organizationId: string) => {
    const doc = await this.getDocumentById(id, organizationId);
    if (!doc) throw new NotFoundError("Document not found");

    await supabaseAdmin.storage.from(BUCKET).remove([doc.storagePath]);
    await db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.organizationId, organizationId)));
  };
}
