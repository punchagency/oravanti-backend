import { createHash, randomBytes } from "crypto";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  max,
  or,
} from "drizzle-orm";
import { supabaseAdmin } from "../../config/supabase";
import { env } from "../../config/env";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import {
  documentAccess,
  documentActivityLogs,
  documentCaseLinks,
  documentFirmAccess,
  documentRequests,
  documents,
  documentTransfers,
  documentVersions,
  externalSubmissions,
} from "../../db/schema/documents";
import { organization, user } from "../../db/schema/auth-schema";
import {
  AuthorizationError,
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { db } from "./../../db/client";

const { SUPABASE_STORAGE_BUCKET } = env;

type DocumentPermission = "VIEW" | "COMMENT" | "EDIT" | "ADMIN";
type DocumentStatus = "active" | "archived" | "deleted";
type DocumentCategory =
  | "application"
  | "supporting"
  | "identity"
  | "uscis_response";

const permissionRank: Record<DocumentPermission, number> = {
  VIEW: 1,
  COMMENT: 2,
  EDIT: 3,
  ADMIN: 4,
};

const hasPermission = (
  actual: DocumentPermission | null,
  required: DocumentPermission,
) => actual !== null && permissionRank[actual] >= permissionRank[required];

const safeStorageName = (name: string, originalFilename: string) => {
  const ext = originalFilename.includes(".")
    ? originalFilename.split(".").pop()
    : undefined;
  const base = name.trim().replace(/[^a-zA-Z0-9-_]+/g, "_") || "document";
  return `${Date.now()}-${base}${ext ? `.${ext}` : ""}`;
};

const buildStoragePath = (
  organizationId: string,
  documentId: string,
  versionNumber: number,
  filename: string,
) => `${organizationId}/documents/${documentId}/v${versionNumber}/${filename}`;

const buildExternalStoragePath = (
  requestId: string,
  filename: string,
) => `external-document-requests/${requestId}/${Date.now()}-${filename}`;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class DocumentsService {
  private logActivity = async (data: {
    documentId?: string;
    actorUserId?: string;
    actorEmail?: string;
    action:
      | "CREATED"
      | "VIEWED"
      | "DOWNLOADED"
      | "VERSION_UPLOADED"
      | "ACCESS_GRANTED"
      | "ACCESS_REVOKED"
      | "TRANSFER_REQUESTED"
      | "TRANSFER_ACCEPTED"
      | "TRANSFER_REJECTED"
      | "EXTERNAL_REQUEST_CREATED"
      | "EXTERNAL_SUBMISSION_UPLOADED"
      | "ARCHIVED"
      | "RESTORED"
      | "SOFT_DELETED";
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }) => {
    await db.insert(documentActivityLogs).values({
      documentId: data.documentId,
      actorUserId: data.actorUserId,
      actorEmail: data.actorEmail,
      action: data.action,
      metadata: data.metadata ?? {},
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });
  };

  private getEffectivePermission = async (
    documentId: string,
    organizationId: string,
    userId?: string,
  ): Promise<DocumentPermission | null> => {
    const [firmGrant] = await db
      .select({ permission: documentFirmAccess.permission })
      .from(documentFirmAccess)
      .where(
        and(
          eq(documentFirmAccess.documentId, documentId),
          eq(documentFirmAccess.firmId, organizationId),
          isNull(documentFirmAccess.revokedAt),
        ),
      )
      .limit(1);

    const permissions: DocumentPermission[] = [];
    if (firmGrant?.permission) {
      permissions.push(firmGrant.permission as DocumentPermission);
    }

    if (userId) {
      const [userGrant] = await db
        .select({ permission: documentAccess.permission })
        .from(documentAccess)
        .where(
          and(
            eq(documentAccess.documentId, documentId),
            eq(documentAccess.userId, userId),
            isNull(documentAccess.revokedAt),
          ),
        )
        .limit(1);

      if (userGrant?.permission) {
        permissions.push(userGrant.permission as DocumentPermission);
      }
    }

    return permissions.reduce<DocumentPermission | null>((highest, current) => {
      if (!highest || permissionRank[current] > permissionRank[highest]) {
        return current;
      }
      return highest;
    }, null);
  };

  private ensurePermission = async (
    documentId: string,
    organizationId: string,
    userId: string | undefined,
    required: DocumentPermission,
  ) => {
    const permission = await this.getEffectivePermission(
      documentId,
      organizationId,
      userId,
    );

    if (!hasPermission(permission, required)) {
      throw new AuthorizationError("Insufficient document permission");
    }

    return permission;
  };

  private getCaseForFirm = async (caseId: string, organizationId: string) => {
    const [row] = await db
      .select()
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)));

    if (!row) {
      throw new NotFoundError("Case not found");
    }

    return row;
  };

  private uploadToStorage = async (data: {
    storagePath: string;
    fileBuffer: Buffer;
    mimeType: string;
  }) => {
    const { error: uploadError } = await supabaseAdmin.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(data.storagePath, data.fileBuffer, {
        contentType: data.mimeType,
        upsert: false,
      });

    if (uploadError) throw new ExternalServiceError(uploadError.message);

    const { data: urlData } = supabaseAdmin.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(data.storagePath);

    return urlData.publicUrl;
  };

  uploadDocument = async (
    organizationId: string,
    data: {
      caseId: string;
      uploadedByUserId: string;
      title: string;
      category?: DocumentCategory;
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    await this.getCaseForFirm(data.caseId, organizationId);

    const [doc] = await db
      .insert(documents)
      .values({
        title: data.title,
        category: data.category,
        originFirmId: organizationId,
        currentOwnerFirmId: organizationId,
        createdByUserId: data.uploadedByUserId,
      })
      .returning();

    const versionNumber = 1;
    const safeFilename = safeStorageName(data.title, data.originalFilename);
    const storagePath = buildStoragePath(
      organizationId,
      doc.id,
      versionNumber,
      safeFilename,
    );
    const fileUrl = await this.uploadToStorage({
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
    });

    const result = await db.transaction(async (tx) => {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: doc.id,
          filePath: storagePath,
          fileUrl,
          originalFileName: data.originalFilename,
          mimeType: data.mimeType,
          fileSize: data.fileSize,
          versionNumber,
          uploadedByUserId: data.uploadedByUserId,
          scanStatus: "SKIPPED",
        })
        .returning();

      const [updatedDocument] = await tx
        .update(documents)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(eq(documents.id, doc.id))
        .returning();

      await tx.insert(documentCaseLinks).values({
        documentId: doc.id,
        caseId: data.caseId,
        linkedByUserId: data.uploadedByUserId,
      });

      await tx.insert(documentFirmAccess).values({
        documentId: doc.id,
        firmId: organizationId,
        permission: "ADMIN",
        grantedByUserId: data.uploadedByUserId,
      });

      await tx.insert(documentAccess).values({
        documentId: doc.id,
        userId: data.uploadedByUserId,
        permission: "ADMIN",
        grantedByUserId: data.uploadedByUserId,
      });

      await tx.insert(documentActivityLogs).values({
        documentId: doc.id,
        actorUserId: data.uploadedByUserId,
        action: "CREATED",
        metadata: { caseId: data.caseId, versionId: version.id },
      });

      return { ...updatedDocument, currentVersion: version };
    });

    return result;
  };

  getAllDocuments = async (
    organizationId: string,
    filters?: {
      search?: string;
      category?: string;
      caseId?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
  ) => {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });

    const conditions = [
      eq(documentFirmAccess.firmId, organizationId),
      isNull(documentFirmAccess.revokedAt),
    ];

    if (filters?.category) {
      conditions.push(eq(documents.category, filters.category as any));
    }
    if (filters?.caseId) {
      conditions.push(eq(documentCaseLinks.caseId, filters.caseId));
      conditions.push(isNull(documentCaseLinks.archivedAt));
    }
    if (filters?.status) {
      conditions.push(eq(documents.status, filters.status as any));
    } else {
      conditions.push(eq(documents.status, "active"));
    }
    if (filters?.search) {
      const search = `%${filters.search}%`;
      const searchCondition = or(
        ilike(documents.title, search),
        ilike(documentVersions.originalFileName, search),
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
      .innerJoin(
        documentFirmAccess,
        eq(documentFirmAccess.documentId, documents.id),
      )
      .leftJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
      )
      .leftJoin(
        documentCaseLinks,
        eq(documentCaseLinks.documentId, documents.id),
      )
      .leftJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .where(where);

    const rows = await db
      .select({
        id: documents.id,
        title: documents.title,
        category: documents.category,
        status: documents.status,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        permission: documentFirmAccess.permission,
        versionId: documentVersions.id,
        fileUrl: documentVersions.fileUrl,
        fileSize: documentVersions.fileSize,
        mimeType: documentVersions.mimeType,
        originalFileName: documentVersions.originalFileName,
        versionNumber: documentVersions.versionNumber,
        scanStatus: documentVersions.scanStatus,
        caseId: cases.id,
        caseType: cases.caseType,
        clientId: clients.id,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
      })
      .from(documents)
      .innerJoin(
        documentFirmAccess,
        eq(documentFirmAccess.documentId, documents.id),
      )
      .leftJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
      )
      .leftJoin(
        documentCaseLinks,
        eq(documentCaseLinks.documentId, documents.id),
      )
      .leftJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .offset(offset);

    return buildPaginatedResponse(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        name: row.title,
        category: row.category,
        status: row.status,
        permission: row.permission,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        currentVersion: row.versionId
          ? {
              id: row.versionId,
              versionNumber: row.versionNumber,
              fileUrl: row.fileUrl,
              fileSize: row.fileSize,
              mimeType: row.mimeType,
              originalFileName: row.originalFileName,
              scanStatus: row.scanStatus,
            }
          : null,
        case: row.caseId
          ? {
              id: row.caseId,
              caseType: row.caseType,
            }
          : null,
        client: row.clientId
          ? { id: row.clientId, name: `${row.clientFirst} ${row.clientLast}` }
          : null,
      })),
      {
        page,
        limit,
        total: Number(total),
      },
    );
  };

  getDocumentStats = async (organizationId: string) => {
    const rows = await db
      .select({ category: documents.category, total: count() })
      .from(documents)
      .innerJoin(
        documentFirmAccess,
        eq(documentFirmAccess.documentId, documents.id),
      )
      .where(
        and(
          eq(documentFirmAccess.firmId, organizationId),
          isNull(documentFirmAccess.revokedAt),
          eq(documents.status, "active"),
        ),
      )
      .groupBy(documents.category);

    const stats: Record<string, number> = {
      application: 0,
      supporting: 0,
      identity: 0,
      uscis_response: 0,
      uncategorized: 0,
    };

    for (const row of rows) {
      stats[row.category ?? "uncategorized"] = Number(row.total);
    }

    return stats;
  };

  getDocumentById = async (
    id: string,
    organizationId: string,
    userId?: string,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "VIEW");

    const [row] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.status, "active")));

    if (!row) return null;

    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, id))
      .orderBy(desc(documentVersions.versionNumber));

    const linkedCases = await db
      .select({
        id: cases.id,
        caseType: cases.caseType,
        clientId: clients.id,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
      })
      .from(documentCaseLinks)
      .innerJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .where(
        and(
          eq(documentCaseLinks.documentId, id),
          isNull(documentCaseLinks.archivedAt),
        ),
      );

    return {
      ...row,
      versions,
      cases: linkedCases.map((linkedCase) => ({
        id: linkedCase.id,
        caseType: linkedCase.caseType,
        client: linkedCase.clientId
          ? {
              id: linkedCase.clientId,
              name: `${linkedCase.clientFirst} ${linkedCase.clientLast}`,
            }
          : null,
      })),
    };
  };

  updateDocumentStatus = async (
    id: string,
    organizationId: string,
    userId: string,
    status: DocumentStatus,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    const now = new Date();
    const [updated] = await db
      .update(documents)
      .set({
        status,
        archivedAt: status === "archived" ? now : null,
        deletedAt: status === "deleted" ? now : null,
        updatedAt: now,
      })
      .where(eq(documents.id, id))
      .returning();

    if (!updated) return null;

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action:
        status === "archived"
          ? "ARCHIVED"
          : status === "deleted"
            ? "SOFT_DELETED"
            : "RESTORED",
      metadata: { status },
    });

    return updated;
  };

  addDocumentVersion = async (
    id: string,
    organizationId: string,
    data: {
      uploadedByUserId: string;
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    await this.ensurePermission(id, organizationId, data.uploadedByUserId, "EDIT");

    const [versionInfo] = await db
      .select({ latest: max(documentVersions.versionNumber) })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, id));

    const versionNumber = Number(versionInfo?.latest ?? 0) + 1;
    const storagePath = buildStoragePath(
      organizationId,
      id,
      versionNumber,
      safeStorageName(`version-${versionNumber}`, data.originalFilename),
    );
    const fileUrl = await this.uploadToStorage({
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
    });

    return db.transaction(async (tx) => {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: id,
          filePath: storagePath,
          fileUrl,
          originalFileName: data.originalFilename,
          mimeType: data.mimeType,
          fileSize: data.fileSize,
          versionNumber,
          uploadedByUserId: data.uploadedByUserId,
          scanStatus: "SKIPPED",
        })
        .returning();

      await tx
        .update(documents)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(eq(documents.id, id));

      await tx.insert(documentActivityLogs).values({
        documentId: id,
        actorUserId: data.uploadedByUserId,
        action: "VERSION_UPLOADED",
        metadata: { versionId: version.id, versionNumber },
      });

      return version;
    });
  };

  linkDocumentToCase = async (
    id: string,
    organizationId: string,
    userId: string,
    caseId: string,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "EDIT");
    await this.getCaseForFirm(caseId, organizationId);

    const [link] = await db
      .insert(documentCaseLinks)
      .values({ documentId: id, caseId, linkedByUserId: userId })
      .onConflictDoUpdate({
        target: [documentCaseLinks.documentId, documentCaseLinks.caseId],
        set: { archivedAt: null, updatedAt: new Date() },
      })
      .returning();

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "ACCESS_GRANTED",
      metadata: { caseId, scope: "case_link" },
    });

    return link;
  };

  grantUserAccess = async (
    id: string,
    organizationId: string,
    userId: string,
    data: { targetUserId: string; permission: DocumentPermission },
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    const [targetUser] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, data.targetUserId))
      .limit(1);
    if (!targetUser) throw new NotFoundError("User not found");

    const [grant] = await db
      .insert(documentAccess)
      .values({
        documentId: id,
        userId: data.targetUserId,
        permission: data.permission,
        grantedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [documentAccess.documentId, documentAccess.userId],
        set: {
          permission: data.permission,
          grantedByUserId: userId,
          revokedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "ACCESS_GRANTED",
      metadata: { userId: data.targetUserId, permission: data.permission },
    });

    return grant;
  };

  grantFirmAccess = async (
    id: string,
    organizationId: string,
    userId: string,
    data: { firmId: string; permission: DocumentPermission },
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    const [targetFirm] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, data.firmId))
      .limit(1);
    if (!targetFirm) throw new NotFoundError("Firm not found");

    const [grant] = await db
      .insert(documentFirmAccess)
      .values({
        documentId: id,
        firmId: data.firmId,
        permission: data.permission,
        grantedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [documentFirmAccess.documentId, documentFirmAccess.firmId],
        set: {
          permission: data.permission,
          grantedByUserId: userId,
          revokedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "ACCESS_GRANTED",
      metadata: { firmId: data.firmId, permission: data.permission },
    });

    return grant;
  };

  revokeUserAccess = async (
    id: string,
    organizationId: string,
    userId: string,
    targetUserId: string,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    const [grant] = await db
      .update(documentAccess)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(documentAccess.documentId, id),
          eq(documentAccess.userId, targetUserId),
        ),
      )
      .returning();

    if (!grant) throw new NotFoundError("Document access not found");

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "ACCESS_REVOKED",
      metadata: { userId: targetUserId },
    });

    return grant;
  };

  revokeFirmAccess = async (
    id: string,
    organizationId: string,
    userId: string,
    firmId: string,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    const [grant] = await db
      .update(documentFirmAccess)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(documentFirmAccess.documentId, id),
          eq(documentFirmAccess.firmId, firmId),
        ),
      )
      .returning();

    if (!grant) throw new NotFoundError("Document firm access not found");

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "ACCESS_REVOKED",
      metadata: { firmId },
    });

    return grant;
  };

  createTransfer = async (
    id: string,
    organizationId: string,
    userId: string,
    data: {
      toFirmId: string;
      toUserId?: string;
      permission: DocumentPermission;
      message?: string;
      revokeSenderAccess?: boolean;
    },
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    const [transfer] = await db
      .insert(documentTransfers)
      .values({
        documentId: id,
        fromFirmId: organizationId,
        toFirmId: data.toFirmId,
        fromUserId: userId,
        toUserId: data.toUserId,
        permission: data.permission,
        message: data.message,
        revokeSenderAccess: data.revokeSenderAccess ?? false,
      })
      .returning();

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "TRANSFER_REQUESTED",
      metadata: {
        transferId: transfer.id,
        toFirmId: data.toFirmId,
        toUserId: data.toUserId,
        permission: data.permission,
      },
    });

    return transfer;
  };

  acceptTransfer = async (
    transferId: string,
    organizationId: string,
    userId: string,
  ) => {
    const [transfer] = await db
      .select()
      .from(documentTransfers)
      .where(
        and(
          eq(documentTransfers.id, transferId),
          eq(documentTransfers.toFirmId, organizationId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundError("Document transfer not found");
    if (transfer.status !== "PENDING") {
      throw new ConflictError("Document transfer is no longer pending");
    }

    return db.transaction(async (tx) => {
      const now = new Date();
      const [updatedTransfer] = await tx
        .update(documentTransfers)
        .set({ status: "ACCEPTED", acceptedAt: now, updatedAt: now })
        .where(eq(documentTransfers.id, transferId))
        .returning();

      await tx
        .insert(documentFirmAccess)
        .values({
          documentId: transfer.documentId,
          firmId: transfer.toFirmId,
          permission: transfer.permission,
          grantedByUserId: transfer.fromUserId,
        })
        .onConflictDoUpdate({
          target: [documentFirmAccess.documentId, documentFirmAccess.firmId],
          set: {
            permission: transfer.permission,
            grantedByUserId: transfer.fromUserId,
            revokedAt: null,
            updatedAt: now,
          },
        });

      if (transfer.toUserId) {
        await tx
          .insert(documentAccess)
          .values({
            documentId: transfer.documentId,
            userId: transfer.toUserId,
            permission: transfer.permission,
            grantedByUserId: transfer.fromUserId,
          })
          .onConflictDoUpdate({
            target: [documentAccess.documentId, documentAccess.userId],
            set: {
              permission: transfer.permission,
              grantedByUserId: transfer.fromUserId,
              revokedAt: null,
              updatedAt: now,
            },
          });
      }

      if (transfer.revokeSenderAccess) {
        await tx
          .update(documentFirmAccess)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(documentFirmAccess.documentId, transfer.documentId),
              eq(documentFirmAccess.firmId, transfer.fromFirmId),
            ),
          );
      }

      await tx.insert(documentActivityLogs).values({
        documentId: transfer.documentId,
        actorUserId: userId,
        action: "TRANSFER_ACCEPTED",
        metadata: { transferId },
      });

      return updatedTransfer;
    });
  };

  rejectTransfer = async (
    transferId: string,
    organizationId: string,
    userId: string,
  ) => {
    const [transfer] = await db
      .update(documentTransfers)
      .set({ status: "REJECTED", updatedAt: new Date() })
      .where(
        and(
          eq(documentTransfers.id, transferId),
          eq(documentTransfers.toFirmId, organizationId),
          eq(documentTransfers.status, "PENDING"),
        ),
      )
      .returning();

    if (!transfer) throw new NotFoundError("Pending document transfer not found");

    await this.logActivity({
      documentId: transfer.documentId,
      actorUserId: userId,
      action: "TRANSFER_REJECTED",
      metadata: { transferId },
    });

    return transfer;
  };

  createExternalRequest = async (
    organizationId: string,
    userId: string,
    data: {
      caseId: string;
      recipientEmail: string;
      recipientName?: string;
      recipientFirmName?: string;
      message?: string;
      expiresAt: Date;
    },
  ) => {
    await this.getCaseForFirm(data.caseId, organizationId);

    const token = randomBytes(32).toString("hex");
    const [request] = await db
      .insert(documentRequests)
      .values({
        caseId: data.caseId,
        requestedByFirmId: organizationId,
        requestedByUserId: userId,
        recipientEmail: data.recipientEmail,
        recipientName: data.recipientName,
        recipientFirmName: data.recipientFirmName,
        message: data.message,
        tokenHash: hashToken(token),
        expiresAt: data.expiresAt,
      })
      .returning();

    await this.logActivity({
      actorUserId: userId,
      action: "EXTERNAL_REQUEST_CREATED",
      metadata: {
        requestId: request.id,
        caseId: data.caseId,
        recipientEmail: data.recipientEmail,
      },
    });

    return { ...request, token };
  };

  submitExternalDocument = async (
    token: string,
    data: {
      uploadedByName: string;
      uploadedByEmail: string;
      title?: string;
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    const [request] = await db
      .select()
      .from(documentRequests)
      .where(eq(documentRequests.tokenHash, hashToken(token)))
      .limit(1);

    if (!request) throw new NotFoundError("Document request not found");
    if (request.status === "CANCELLED" || request.status === "EXPIRED") {
      throw new ConflictError("Document request is not open");
    }
    if (request.expiresAt.getTime() <= Date.now()) {
      await db
        .update(documentRequests)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(eq(documentRequests.id, request.id));
      throw new ConflictError("Document request has expired");
    }

    const title = data.title ?? data.originalFilename;
    const [doc] = await db
      .insert(documents)
      .values({
        title,
        originFirmId: request.requestedByFirmId,
        currentOwnerFirmId: request.requestedByFirmId,
      })
      .returning();

    const storagePath = buildExternalStoragePath(
      request.id,
      safeStorageName(title, data.originalFilename),
    );
    const fileUrl = await this.uploadToStorage({
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
    });

    return db.transaction(async (tx) => {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: doc.id,
          filePath: storagePath,
          fileUrl,
          originalFileName: data.originalFilename,
          mimeType: data.mimeType,
          fileSize: data.fileSize,
          versionNumber: 1,
          scanStatus: "SKIPPED",
        })
        .returning();

      await tx
        .update(documents)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(eq(documents.id, doc.id));

      const [submission] = await tx
        .insert(externalSubmissions)
        .values({
          requestId: request.id,
          documentId: doc.id,
          documentVersionId: version.id,
          uploadedByName: data.uploadedByName,
          uploadedByEmail: data.uploadedByEmail,
          originalFileName: data.originalFilename,
          filePath: storagePath,
          mimeType: data.mimeType,
          fileSize: data.fileSize,
          scanStatus: "SKIPPED",
        })
        .returning();

      await tx.insert(documentCaseLinks).values({
        documentId: doc.id,
        caseId: request.caseId,
      });

      await tx.insert(documentFirmAccess).values({
        documentId: doc.id,
        firmId: request.requestedByFirmId,
        permission: "ADMIN",
        grantedByUserId: request.requestedByUserId,
      });

      await tx
        .update(documentRequests)
        .set({ status: "SUBMITTED", updatedAt: new Date() })
        .where(eq(documentRequests.id, request.id));

      await tx.insert(documentActivityLogs).values({
        documentId: doc.id,
        actorEmail: data.uploadedByEmail,
        action: "EXTERNAL_SUBMISSION_UPLOADED",
        metadata: {
          requestId: request.id,
          submissionId: submission.id,
          versionId: version.id,
        },
      });

      return { document: doc, version, submission };
    });
  };

  archiveDocument = async (
    id: string,
    organizationId: string,
    userId: string,
  ) => this.updateDocumentStatus(id, organizationId, userId, "archived");

  restoreDocument = async (
    id: string,
    organizationId: string,
    userId: string,
  ) => this.updateDocumentStatus(id, organizationId, userId, "active");

  deleteDocument = async (
    id: string,
    organizationId: string,
    userId: string,
  ) => this.updateDocumentStatus(id, organizationId, userId, "deleted");

  getDownloadUrl = async (
    id: string,
    organizationId: string,
    userId?: string,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "VIEW");

    const [doc] = await db
      .select({
        id: documents.id,
        filePath: documentVersions.filePath,
      })
      .from(documents)
      .innerJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
      )
      .where(and(eq(documents.id, id), eq(documents.status, "active")))
      .limit(1);

    if (!doc) throw new NotFoundError("Document not found");

    const { data, error } = await supabaseAdmin.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .createSignedUrl(doc.filePath, 60 * 60);

    if (error) throw new ExternalServiceError(error.message);

    if (userId) {
      await this.logActivity({
        documentId: id,
        actorUserId: userId,
        action: "DOWNLOADED",
      });
    }

    return data.signedUrl;
  };

  getActivityLogs = async (
    id: string,
    organizationId: string,
    userId: string,
  ) => {
    await this.ensurePermission(id, organizationId, userId, "ADMIN");

    return db
      .select()
      .from(documentActivityLogs)
      .where(eq(documentActivityLogs.documentId, id))
      .orderBy(desc(documentActivityLogs.createdAt));
  };

  getTransfers = async (organizationId: string) =>
    db
      .select()
      .from(documentTransfers)
      .where(
        or(
          eq(documentTransfers.fromFirmId, organizationId),
          eq(documentTransfers.toFirmId, organizationId),
        ),
      )
      .orderBy(desc(documentTransfers.createdAt));

  getExternalRequests = async (organizationId: string) =>
    db
      .select()
      .from(documentRequests)
      .where(eq(documentRequests.requestedByFirmId, organizationId))
      .orderBy(desc(documentRequests.createdAt));

  cancelExternalRequest = async (
    id: string,
    organizationId: string,
    userId: string,
  ) => {
    const [request] = await db
      .update(documentRequests)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(
        and(
          eq(documentRequests.id, id),
          eq(documentRequests.requestedByFirmId, organizationId),
          inArray(documentRequests.status, ["PENDING", "PARTIALLY_SUBMITTED"]),
        ),
      )
      .returning();

    if (!request) throw new NotFoundError("Open document request not found");

    await this.logActivity({
      actorUserId: userId,
      action: "ACCESS_REVOKED",
      metadata: { requestId: id, scope: "external_request" },
    });

    return request;
  };
}
