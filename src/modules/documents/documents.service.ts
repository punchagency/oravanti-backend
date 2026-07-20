import { createHash, randomBytes, randomUUID } from "crypto";
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
import { db } from "../../db/client";
import { user } from "../../db/schema/auth-schema";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import {
  documentAccess,
  documentActivityLogs,
  documentCaseLinks,
  documentRequests,
  documents,
  documentVersions,
  externalSubmissions,
} from "../../db/schema/documents";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { storageService } from "../../utils/storage/storage.service";

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
  ownerKey: string,
  documentId: string,
  versionNumber: number,
  filename: string,
) => `${ownerKey}/documents/${documentId}/v${versionNumber}/${filename}`;

const buildExternalStoragePath = (requestId: string, filename: string) =>
  `external-document-requests/${requestId}/${Date.now()}-${filename}`;

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
    userId: string,
  ): Promise<DocumentPermission | null> => {
    const permissions: DocumentPermission[] = [];
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

    return permissions.reduce<DocumentPermission | null>((highest, current) => {
      if (!highest || permissionRank[current] > permissionRank[highest]) {
        return current;
      }
      return highest;
    }, null);
  };

  private ensurePermission = async (
    documentId: string,
    userId: string,
    required: DocumentPermission,
  ) => {
    const permission = await this.getEffectivePermission(documentId, userId);

    if (!hasPermission(permission, required)) {
      throw new AuthorizationError("Insufficient document permission");
    }

    return permission;
  };

  private getCaseForFirm = async (caseId: string, organizationId: string) => {
    const [row] = await db
      .select()
      .from(cases)
      .where(
        and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)),
      );

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
    await storageService.upload({
      key: data.storagePath,
      body: data.fileBuffer,
      contentType: data.mimeType,
    });
  };

  private removeFromStorage = async (storagePath: string) => {
    await storageService.remove([storagePath]);
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

    const documentId = randomUUID();
    const versionNumber = 1;
    const safeFilename = safeStorageName(data.title, data.originalFilename);
    const storagePath = buildStoragePath(
      data.uploadedByUserId,
      documentId,
      versionNumber,
      safeFilename,
    );
    await this.uploadToStorage({
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
    });

    try {
      return await db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values({
            id: documentId,
            title: data.title,
            category: data.category,
            createdByUserId: data.uploadedByUserId,
          })
          .returning();

        const [version] = await tx
          .insert(documentVersions)
          .values({
            documentId: doc.id,
            filePath: storagePath,
            originalFileName: data.originalFilename,
            mimeType: data.mimeType,
            fileSize: data.fileSize,
            versionNumber,
            uploadedByUserId: data.uploadedByUserId,
            virusScanStatus: "SKIPPED",
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
    } catch (error) {
      await this.removeFromStorage(storagePath).catch(() => undefined);
      throw error;
    }
  };

  getAllDocuments = async (
    userId: string,
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
      eq(documentAccess.userId, userId),
      isNull(documentAccess.revokedAt),
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
        ilike(clients.displayName, search),
      );

      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(documents)
      .innerJoin(documentAccess, eq(documentAccess.documentId, documents.id))
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
        permission: documentAccess.permission,
        versionId: documentVersions.id,
        filePath: documentVersions.filePath,
        fileSize: documentVersions.fileSize,
        mimeType: documentVersions.mimeType,
        originalFileName: documentVersions.originalFileName,
        versionNumber: documentVersions.versionNumber,
        virusScanStatus: documentVersions.virusScanStatus,
        caseId: cases.id,
        caseTypeId: cases.caseTypeId,
        clientId: clients.id,
        clientDisplayName: clients.displayName,
      })
      .from(documents)
      .innerJoin(documentAccess, eq(documentAccess.documentId, documents.id))
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

    const items = await Promise.all(
      rows.map(async (row) => ({
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
              fileUrl: row.filePath
                ? await storageService.getSignedDownloadUrl(row.filePath)
                : null,
              fileSize: row.fileSize,
              mimeType: row.mimeType,
              originalFileName: row.originalFileName,
              virusScanStatus: row.virusScanStatus,
            }
          : null,
        case: row.caseId
          ? {
              id: row.caseId,
              caseType: row.caseTypeId,
            }
          : null,
        client: row.clientId
          ? { id: row.clientId, name: row.clientDisplayName ?? '' }
          : null,
      })),
    );

    return buildPaginatedResponse(
      items,
      {
        page,
        limit,
        total: Number(total),
      },
    );
  };

  getDocumentStats = async (userId: string) => {
    const rows = await db
      .select({ category: documents.category, total: count() })
      .from(documents)
      .innerJoin(documentAccess, eq(documentAccess.documentId, documents.id))
      .where(
        and(
          eq(documentAccess.userId, userId),
          isNull(documentAccess.revokedAt),
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

  getDocumentById = async (id: string, userId: string) => {
    await this.ensurePermission(id, userId, "VIEW");

    const [row] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.status, "active")));

    if (!row) return null;

    const versionRows = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, id))
      .orderBy(desc(documentVersions.versionNumber));

    const versions = await Promise.all(
      versionRows.map(async (version) => ({
        ...version,
        fileUrl: await storageService.getSignedDownloadUrl(version.filePath),
      })),
    );

    const linkedCases = await db
      .select({
        id: cases.id,
        caseTypeId: cases.caseTypeId,
        clientId: clients.id,
        clientDisplayName: clients.displayName,
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
        caseType: linkedCase.caseTypeId,
        client: linkedCase.clientId
          ? {
              id: linkedCase.clientId,
              name: linkedCase.clientDisplayName ?? '',
            }
          : null,
      })),
    };
  };

  updateDocumentStatus = async (
    id: string,
    userId: string,
    status: DocumentStatus,
  ) => {
    await this.ensurePermission(id, userId, "ADMIN");

    return db.transaction(async (tx) => {
      const now = new Date();
      const [updated] = await tx
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

      await tx.insert(documentActivityLogs).values({
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
    });
  };

  updateDocument = async (
    id: string,
    data: {
      uploadedByUserId: string;
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    await this.ensurePermission(id, data.uploadedByUserId, "EDIT");

    const [versionInfo] = await db
      .select({ latest: max(documentVersions.versionNumber) })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, id));

    const versionNumber = Number(versionInfo?.latest ?? 0) + 1;
    const storagePath = buildStoragePath(
      data.uploadedByUserId,
      id,
      versionNumber,
      safeStorageName(`version-${versionNumber}`, data.originalFilename),
    );
    await this.uploadToStorage({
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
    });

    try {
      return await db.transaction(async (tx) => {
        const [version] = await tx
          .insert(documentVersions)
          .values({
            documentId: id,
            filePath: storagePath,
            originalFileName: data.originalFilename,
            mimeType: data.mimeType,
            fileSize: data.fileSize,
            versionNumber,
            uploadedByUserId: data.uploadedByUserId,
            virusScanStatus: "SKIPPED",
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
    } catch (error) {
      await this.removeFromStorage(storagePath).catch(() => undefined);
      throw error;
    }
  };

  linkDocumentToCase = async (
    id: string,
    organizationId: string,
    userId: string,
    caseId: string,
  ) => {
    await this.ensurePermission(id, userId, "EDIT");
    await this.getCaseForFirm(caseId, organizationId);

    return db.transaction(async (tx) => {
      const [link] = await tx
        .insert(documentCaseLinks)
        .values({ documentId: id, caseId, linkedByUserId: userId })
        .onConflictDoUpdate({
          target: [documentCaseLinks.documentId, documentCaseLinks.caseId],
          set: { archivedAt: null, updatedAt: new Date() },
        })
        .returning();

      await tx.insert(documentActivityLogs).values({
        documentId: id,
        actorUserId: userId,
        action: "ACCESS_GRANTED",
        metadata: { caseId, scope: "case_link" },
      });

      return link;
    });
  };

  grantUserAccess = async (
    id: string,
    userId: string,
    data: { targetUserId: string; permission: DocumentPermission },
  ) => {
    await this.ensurePermission(id, userId, "ADMIN");

    const [targetUser] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, data.targetUserId))
      .limit(1);
    if (!targetUser) throw new NotFoundError("User not found");

    return db.transaction(async (tx) => {
      const [grant] = await tx
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

      await tx.insert(documentActivityLogs).values({
        documentId: id,
        actorUserId: userId,
        action: "ACCESS_GRANTED",
        metadata: { userId: data.targetUserId, permission: data.permission },
      });

      return grant;
    });
  };

  revokeUserAccess = async (
    id: string,
    userId: string,
    targetUserId: string,
  ) => {
    await this.ensurePermission(id, userId, "ADMIN");

    return db.transaction(async (tx) => {
      const [grant] = await tx
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

      await tx.insert(documentActivityLogs).values({
        documentId: id,
        actorUserId: userId,
        action: "ACCESS_REVOKED",
        metadata: { userId: targetUserId },
      });

      return grant;
    });
  };

  createExternalRequest = async (
    organizationId: string,
    userId: string,
    data: {
      caseId: string;
      recipientEmail: string;
      recipientName?: string;
      message?: string;
      expiresAt: Date;
    },
  ) => {
    await this.getCaseForFirm(data.caseId, organizationId);

    const token = randomBytes(32).toString("hex");
    const request = await db.transaction(async (tx) => {
      const [createdRequest] = await tx
        .insert(documentRequests)
        .values({
          caseId: data.caseId,
          requestedByUserId: userId,
          recipientEmail: data.recipientEmail,
          recipientName: data.recipientName,
          message: data.message,
          tokenHash: hashToken(token),
          expiresAt: data.expiresAt,
        })
        .returning();

      await tx.insert(documentActivityLogs).values({
        actorUserId: userId,
        action: "EXTERNAL_REQUEST_CREATED",
        metadata: {
          requestId: createdRequest.id,
          caseId: data.caseId,
          recipientEmail: data.recipientEmail,
        },
      });

      return createdRequest;
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
    const documentId = randomUUID();
    const storagePath = buildExternalStoragePath(
      request.id,
      safeStorageName(title, data.originalFilename),
    );
    await this.uploadToStorage({
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
    });

    try {
      return await db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values({
            id: documentId,
            title,
            createdByUserId: request.requestedByUserId,
          })
          .returning();

        const [version] = await tx
          .insert(documentVersions)
          .values({
            documentId: doc.id,
            filePath: storagePath,
            originalFileName: data.originalFilename,
            mimeType: data.mimeType,
            fileSize: data.fileSize,
            versionNumber: 1,
            virusScanStatus: "SKIPPED",
          })
          .returning();

        const [updatedDocument] = await tx
          .update(documents)
          .set({ currentVersionId: version.id, updatedAt: new Date() })
          .where(eq(documents.id, doc.id))
          .returning();

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
            virusScanStatus: "SKIPPED",
          })
          .returning();

        await tx.insert(documentCaseLinks).values({
          documentId: doc.id,
          caseId: request.caseId,
        });

        await tx.insert(documentAccess).values({
          documentId: doc.id,
          userId: request.requestedByUserId,
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

        return { document: updatedDocument, version, submission };
      });
    } catch (error) {
      await this.removeFromStorage(storagePath).catch(() => undefined);
      throw error;
    }
  };

  archiveDocument = async (id: string, userId: string) =>
    this.updateDocumentStatus(id, userId, "archived");

  restoreDocument = async (id: string, userId: string) =>
    this.updateDocumentStatus(id, userId, "active");

  deleteDocument = async (id: string, userId: string) =>
    this.updateDocumentStatus(id, userId, "deleted");

  getDownloadUrl = async (id: string, userId: string) => {
    await this.ensurePermission(id, userId, "VIEW");

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

    const signedUrl = await storageService.getSignedDownloadUrl(doc.filePath);

    await this.logActivity({
      documentId: id,
      actorUserId: userId,
      action: "DOWNLOADED",
    }).catch(() => undefined);

    return signedUrl;
  };

  getActivityLogs = async (id: string, userId: string) => {
    await this.ensurePermission(id, userId, "ADMIN");

    return db
      .select()
      .from(documentActivityLogs)
      .where(eq(documentActivityLogs.documentId, id))
      .orderBy(desc(documentActivityLogs.createdAt));
  };

  getCaseDocuments = async (
    caseId: string,
    organizationId: string,
    page?: number,
    limit?: number,
  ) => {
    const resolvedPage = page ?? 1;
    const resolvedLimit = limit ?? 20;
    const offset = getPaginationOffset({ page: resolvedPage, limit: resolvedLimit });

    await this.getCaseForFirm(caseId, organizationId);

    const conditions = [
      eq(documentCaseLinks.caseId, caseId),
      isNull(documentCaseLinks.archivedAt),
      eq(documents.status, "active"),
    ];

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(documents)
      .innerJoin(
        documentCaseLinks,
        and(
          eq(documentCaseLinks.documentId, documents.id),
          eq(documentCaseLinks.caseId, caseId),
          isNull(documentCaseLinks.archivedAt),
        ),
      )
      .leftJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
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
        versionId: documentVersions.id,
        filePath: documentVersions.filePath,
        fileSize: documentVersions.fileSize,
        mimeType: documentVersions.mimeType,
        originalFileName: documentVersions.originalFileName,
        versionNumber: documentVersions.versionNumber,
        virusScanStatus: documentVersions.virusScanStatus,
        caseId: cases.id,
        caseTypeId: cases.caseTypeId,
        clientId: clients.id,
        clientDisplayName: clients.displayName,
      })
      .from(documents)
      .innerJoin(
        documentCaseLinks,
        and(
          eq(documentCaseLinks.documentId, documents.id),
          eq(documentCaseLinks.caseId, caseId),
          isNull(documentCaseLinks.archivedAt),
        ),
      )
      .leftJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
      )
      .leftJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(resolvedLimit)
      .offset(offset);

    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        title: row.title,
        name: row.title,
        category: row.category,
        status: row.status,
        permission: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        currentVersion: row.versionId
          ? {
              id: row.versionId,
              versionNumber: row.versionNumber,
              fileUrl: row.filePath
                ? await storageService.getSignedDownloadUrl(row.filePath)
                : null,
              fileSize: row.fileSize,
              mimeType: row.mimeType,
              originalFileName: row.originalFileName,
              virusScanStatus: row.virusScanStatus,
            }
          : null,
        case: row.caseId
          ? {
              id: row.caseId,
              caseType: row.caseTypeId,
            }
          : null,
        client: row.clientId
          ? { id: row.clientId, name: row.clientDisplayName ?? '' }
          : null,
      })),
    );

    return buildPaginatedResponse(
      items,
      {
        page: resolvedPage,
        limit: resolvedLimit,
        total: Number(total),
      },
    );
  };

  getExternalRequests = async (userId: string) =>
    db
      .select()
      .from(documentRequests)
      .where(eq(documentRequests.requestedByUserId, userId))
      .orderBy(desc(documentRequests.createdAt));

  cancelExternalRequest = async (id: string, userId: string) => {
    return db.transaction(async (tx) => {
      const [request] = await tx
        .update(documentRequests)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(documentRequests.id, id),
            eq(documentRequests.requestedByUserId, userId),
            inArray(documentRequests.status, [
              "PENDING",
              "PARTIALLY_SUBMITTED",
            ]),
          ),
        )
        .returning();

      if (!request) throw new NotFoundError("Open document request not found");

      await tx.insert(documentActivityLogs).values({
        actorUserId: userId,
        action: "ACCESS_REVOKED",
        metadata: { requestId: id, scope: "external_request" },
      });

      return request;
    });
  };
}
