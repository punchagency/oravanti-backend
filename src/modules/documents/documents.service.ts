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
  sql,
} from "drizzle-orm";
import { db } from "../../db/client";
import { organization, user } from "../../db/schema/auth-schema";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import {
  documentAccess,
  documentCaseLinks,
  documentRequests,
  documents,
  documentVersions,
  externalSubmissions,
} from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import { leads } from "../../db/schema/leads";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreas } from "../../db/schema/practice-areas";
import {
  AuthorizationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { storageService } from "../../utils/storage/storage.service";
import { emailService } from "../../utils/email/email.service";
import { generateDocumentRequestEmailTemplate } from "../../utils/email/email.types";
import { env } from "../../config/env";
import { notify } from "../../notifications/notification.service";
import {
  triggerScanForDocument,
  triggerScenarioScan,
} from "../ai-scan/scan-triggers";
import { recordAccessEvent, recordAuditEvent } from "../shared/audit.service";
import type { AuditActionName } from "../../lib/audit/actions";
import { auditEvents } from "../../db/schema/audit-events";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";

const log = createModuleLogger("documents.service");

/*
  The document module's slice of the action registry.

  Derived from AUDIT_ACTIONS rather than restated, so a document action added
  to the registry is usable here immediately and one removed from it stops
  compiling here — which is the property the old hand-written UPPERCASE union
  did not have.
*/
type DocumentAuditAction = Extract<AuditActionName, `document.${string}`>;

type DocumentPermission = "VIEW" | "COMMENT" | "EDIT" | "ADMIN";
type DocumentStatus = "active" | "archived" | "deleted";
type DocumentCategory =
  | "application"
  | "supporting"
  | "identity"
  | "uscis_response";
type DocumentRequestStatus =
  | "PENDING"
  | "SUBMITTED"
  | "PARTIALLY_SUBMITTED"
  | "EXPIRED"
  | "CANCELLED";

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

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a client has to act on a link, matching the AI-review dispatcher. */
export const REQUEST_EXPIRY_DAYS = 14;

/** The default expiry for a link issued now. */
export const defaultRequestExpiry = () =>
  new Date(Date.now() + REQUEST_EXPIRY_DAYS * DAY_MS);

export class DocumentsService {
  /*
    Document activity is `audit_events`, like everything else.

    This module was the last of the eleven trails still writing to its own
    table. `document_activity_logs` had no organization_id at all, so it was
    the one audit table no tenant filter could reach; its actor was a bare
    user id with no name snapshot, so deleting a staff member blanked the
    history; and its timestamp had no timezone. Every one of those is fixed by
    the row shape `recordAuditEvent` writes.

    Actor, organization, IP, user-agent and requestId all come from the
    request context, so a call site passes only what is specific to the event.
    The externally-submitted case is the exception and passes an explicit
    actor, because the submitter has an email and no account.
  */
  private logActivity = async (data: {
    documentId?: string;
    actorEmail?: string;
    action: DocumentAuditAction;
    metadata?: Record<string, unknown>;
  }) => {
    await recordAuditEvent({
      action: data.action,
      entityType: "document",
      entityId: data.documentId ?? null,
      metadata: data.metadata ?? {},
      // Never blocks the operation it describes: these are recorded after the
      // storage write has already happened, so throwing here would roll back a
      // change that is real.
      onWriteFailure: "log",
      ...(data.actorEmail
        ? { actor: { type: "anonymous" as const, name: data.actorEmail, email: data.actorEmail } }
        : {}),
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
      const created = await db.transaction(async (tx) => {
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

        await this.logActivity({
          documentId: doc.id,
          action: "document.created",
          metadata: { caseId: data.caseId, versionId: version.id },
        });

        return { ...updatedDocument, currentVersion: version };
      });

      // Scan the case once the upload is committed (fire-and-forget).
      triggerScenarioScan({
        organizationId,
        scenarioType: "case",
        scenarioId: data.caseId,
        trigger: "upload",
      });

      return created;
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

      await this.logActivity({
        documentId: id,
        action:
          status === "archived"
            ? "document.archived"
            : status === "deleted"
              ? "document.soft_deleted"
              : "document.restored",
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
      const created = await db.transaction(async (tx) => {
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

        await this.logActivity({
          documentId: id,
          action: "document.version_uploaded",
          metadata: { versionId: version.id, versionNumber },
        });

        return version;
      });

      // A new version invalidates prior analysis (new checksum) — re-scan every
      // scenario this document belongs to. Resolves scenario + org internally.
      void triggerScanForDocument(id, "upload");

      return created;
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

    const link = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documentCaseLinks)
        .values({ documentId: id, caseId, linkedByUserId: userId })
        .onConflictDoUpdate({
          target: [documentCaseLinks.documentId, documentCaseLinks.caseId],
          set: { archivedAt: null, updatedAt: new Date() },
        })
        .returning();

      await this.logActivity({
        documentId: id,
        action: "document.access_granted",
        metadata: { caseId, scope: "case_link" },
      });

      return row;
    });

    // A newly-linked document is now in the case's scan set.
    triggerScenarioScan({
      organizationId,
      scenarioType: "case",
      scenarioId: caseId,
      trigger: "upload",
    });

    return link;
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

      await this.logActivity({
        documentId: id,
        action: "document.access_granted",
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

      await this.logActivity({
        documentId: id,
        action: "document.access_revoked",
        metadata: { userId: targetUserId },
      });

      return grant;
    });
  };

  /**
   * Create an outstanding request for a document from someone outside the firm.
   *
   * The matter is a case or a lead, never both — AI case review raises most of
   * its findings during intake, before a case exists. The raw token is returned
   * to the caller and only its hash is stored, so the link can be sent but never
   * recovered afterwards.
   */
  createExternalRequest = async (
    organizationId: string,
    userId: string,
    data: {
      caseId?: string;
      leadId?: string;
      recipientEmail: string;
      recipientName?: string;
      requestedLabel?: string;
      message?: string;
      expiresAt: Date;
    },
  ) => {
    if (!data.caseId === !data.leadId) {
      throw new BadRequestError(
        "A document request belongs to exactly one case or lead",
      );
    }
    // Both paths must prove the matter belongs to this firm — the request grants
    // an unauthenticated upload against it.
    if (data.caseId) {
      await this.getCaseForFirm(data.caseId, organizationId);
    } else {
      const [lead] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.id, data.leadId!),
            eq(leads.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!lead) throw new NotFoundError("Lead not found");
    }

    const token = randomBytes(32).toString("hex");
    const request = await db.transaction(async (tx) => {
      const [createdRequest] = await tx
        .insert(documentRequests)
        .values({
          organizationId,
          caseId: data.caseId ?? null,
          leadId: data.leadId ?? null,
          requestedByUserId: userId,
          recipientEmail: data.recipientEmail,
          recipientName: data.recipientName,
          requestedLabel: data.requestedLabel,
          message: data.message,
          tokenHash: hashToken(token),
          expiresAt: data.expiresAt,
        })
        .returning();

      await recordAuditEvent({
        action: "document.external_request_created",
        // The registry types this action against document_request, and there
        // is no document yet — the request is what asks for one.
        entityId: createdRequest.id,
        parentEntityType: data.caseId ? "case" : data.leadId ? "lead" : null,
        parentEntityId: data.caseId ?? data.leadId ?? null,
        onWriteFailure: "log",
        metadata: {
          requestId: createdRequest.id,
          caseId: data.caseId ?? null,
          leadId: data.leadId ?? null,
          recipientEmail: data.recipientEmail,
        },
      });

      return createdRequest;
    });

    return { ...request, token };
  };

  /**
   * Create a document request *and* deliver it.
   *
   * `createExternalRequest` only records the request — the AI-review dispatcher
   * pairs it with its own email. A request raised by hand from a matter has no
   * such partner, so the delivery lives here: a request the client never hears
   * about is a request that never happens.
   */
  requestDocumentFromClient = async (
    organizationId: string,
    userId: string,
    data: {
      caseId?: string;
      leadId?: string;
      recipientEmail: string;
      recipientName?: string;
      requestedLabel: string;
      message?: string;
      expiresAt: Date;
    },
  ) => {
    const request = await this.createExternalRequest(organizationId, userId, data);

    const [org] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    const uploadLink = `${env.FRONTEND_APP_URL}/document-upload/${request.token}`;

    // The request is already committed by this point, so a bounced send must not
    // undo it. The caller gets `emailSent: false` and the link to pass on itself.
    let emailSent = true;
    try {
      await emailService.sendEmail({
        to: data.recipientEmail,
        subject: `Document requested: ${data.requestedLabel}`,
        html: generateDocumentRequestEmailTemplate({
          recipientName: data.recipientName ?? null,
          firmName: org?.name ?? "Your legal team",
          requestedLabel: data.requestedLabel,
          reason:
            data.message?.trim() ||
            "Your legal team needs this document to keep your matter moving.",
          uploadLink,
          expiresAt: data.expiresAt,
        }),
      });
    } catch {
      emailSent = false;
    }

    return { ...request, uploadLink, emailSent };
  };

  /**
   * What the recipient of an upload link is allowed to see about the request.
   *
   * The token is the only credential here, so this stays to what the client
   * already knows: which of their matters this is (they may well have several),
   * what was asked for, and how long they have. Status comes back too — a dead
   * link should say so on arrival rather than after they pick a file.
   */
  getRequestByToken = async (token: string) => {
    const [row] = await db
      .select({
        id: documentRequests.id,
        status: documentRequests.status,
        expiresAt: documentRequests.expiresAt,
        requestedLabel: documentRequests.requestedLabel,
        message: documentRequests.message,
        recipientName: documentRequests.recipientName,
        firmName: organization.name,
        caseId: cases.id,
        caseNumber: cases.caseNumber,
        caseTypeName: practiceAreaCaseTypes.name,
        practiceAreaName: practiceAreas.name,
        clientName: clients.displayName,
        leadId: leads.id,
        leadFirstName: leads.firstName,
        leadLastName: leads.lastName,
      })
      .from(documentRequests)
      .leftJoin(organization, eq(organization.id, documentRequests.organizationId))
      .leftJoin(cases, eq(cases.id, documentRequests.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .leftJoin(leads, eq(leads.id, documentRequests.leadId))
      .leftJoin(
        practiceAreas,
        sql`${practiceAreas.id} = COALESCE(${cases.practiceAreaId}, ${leads.practiceAreaId})`,
      )
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, cases.caseTypeId),
      )
      .where(eq(documentRequests.tokenHash, hashToken(token)))
      .limit(1);

    if (!row) throw new NotFoundError("Document request not found");

    // Read as expired rather than reporting a stale PENDING; the submit path
    // flips the row itself when someone actually tries to use it.
    const expired = row.expiresAt.getTime() <= Date.now();
    const status = expired && row.status === "PENDING" ? "EXPIRED" : row.status;

    return {
      status,
      expiresAt: row.expiresAt,
      requestedLabel: row.requestedLabel,
      message: row.message,
      recipientName: row.recipientName,
      firmName: row.firmName,
      matter: row.caseId
        ? {
            type: "case" as const,
            reference: row.caseNumber,
            caseType: row.caseTypeName,
            practiceArea: row.practiceAreaName,
            clientName: row.clientName,
          }
        : {
            type: "lead" as const,
            reference: null,
            caseType: null,
            practiceArea: row.practiceAreaName,
            clientName:
              [row.leadFirstName, row.leadLastName].filter(Boolean).join(" ") ||
              null,
          },
    };
  };

  /**
   * Nudge an open request: a fresh link, emailed as a reminder.
   *
   * Rotation is the price of never storing the raw token — the only way to send
   * the link a second time is to issue a new one, which retires whatever the
   * recipient already had. The fresh link is returned so the caller can offer it
   * for copying; this is the last moment it is readable.
   */
  reissueExternalRequest = async (
    id: string,
    organizationId: string,
    _userId: string,
  ) => {
    const [existing] = await db
      .select()
      .from(documentRequests)
      .where(
        and(
          eq(documentRequests.id, id),
          eq(documentRequests.organizationId, organizationId),
          inArray(documentRequests.status, ["PENDING", "PARTIALLY_SUBMITTED"]),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundError("Open document request not found");

    const token = randomBytes(32).toString("hex");
    // A link the client has a day to act on is no use as a nudge, so the clock
    // restarts with the link it belongs to.
    const expiresAt = defaultRequestExpiry();

    const [request] = await db
      .update(documentRequests)
      .set({ tokenHash: hashToken(token), expiresAt, updatedAt: new Date() })
      .where(eq(documentRequests.id, id))
      .returning();

    const uploadLink = `${env.FRONTEND_APP_URL}/document-upload/${token}`;

    const [org] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    // The rotation is already committed, so a bounced reminder must not fail the
    // call — the caller still has a link it can pass on by hand.
    let emailSent = true;
    try {
      await emailService.sendEmail({
        to: request.recipientEmail,
        subject: `Reminder: ${request.requestedLabel ?? "a document"} is still needed`,
        html: generateDocumentRequestEmailTemplate({
          recipientName: request.recipientName,
          firmName: org?.name ?? "Your legal team",
          requestedLabel: request.requestedLabel ?? "A document for your matter",
          reason:
            request.message?.trim() ||
            "This is a reminder — we still need this document to keep your matter moving.",
          uploadLink,
          expiresAt,
        }),
      });
    } catch {
      emailSent = false;
    }

    await recordAuditEvent({
      action: "document.external_request_created",
      entityId: id,
      onWriteFailure: "log",
      summary: "Document request reissued",
      metadata: {
        requestId: id,
        reissued: true,
        notified: emailSent,
        recipientEmail: request.recipientEmail,
      },
    });

    return { ...request, uploadLink, emailSent };
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
      const result = await db.transaction(async (tx) => {
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

        // Link to whichever matter the request was raised against.
        if (request.caseId) {
          await tx.insert(documentCaseLinks).values({
            documentId: doc.id,
            caseId: request.caseId,
          });
        } else {
          await tx.insert(leadDocumentLinks).values({
            leadId: request.leadId!,
            documentId: doc.id,
          });
        }

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

        await this.logActivity({
          documentId: doc.id,
          // Submitted from outside the firm: there is no account, so the
          // actor is the email the link was sent to.
          actorEmail: data.uploadedByEmail,
          action: "document.external_submission_uploaded",
          metadata: {
            requestId: request.id,
            submissionId: submission.id,
            versionId: version.id,
          },
        });

        return { document: updatedDocument, version, submission };
      });

      // External submission adds a document to the request's case — scan it.
      void triggerScanForDocument(result.document.id, "upload");

      /**
       * Tell the firm the client uploaded something.
       *
       * This path had no notification at all: a client responded to a document
       * request and the firm found out by happening to look. The request itself
       * was emailed, so the silence was one-directional in the worst way —
       * we asked, they answered, nobody heard.
       *
       * The requester is the right recipient rather than the whole firm: they
       * raised the request and are waiting on it.
       */
      void this.notifyUploadReceived(request, title, data.uploadedByName);

      return result;
    } catch (error) {
      await this.removeFromStorage(storagePath).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Notify the staff member who raised a document request that it was answered.
   *
   * The recipient is a `user` rather than `staff`: document requests record
   * `requestedByUserId`, a Better Auth user id, and mapping it back to a staff
   * row would be a lookup that can fail for an admin who has no staff record.
   */
  private notifyUploadReceived = async (
    request: typeof documentRequests.$inferSelect,
    documentTitle: string,
    uploadedByName: string,
  ) => {
    try {
      await notify({
        organizationId: request.organizationId,
        event: "document_uploaded_staff",
        recipients: [{ type: "user", id: request.requestedByUserId }],
        context: {
          documentTitle,
          uploadedBy: uploadedByName,
          link: request.caseId
            ? `${env.FRONTEND_APP_URL}/admin/cases/${request.caseId}`
            : `${env.FRONTEND_APP_URL}/admin/leads/${request.leadId}`,
        },
        scenario: {
          caseId: request.caseId ?? undefined,
          leadId: request.leadId ?? undefined,
        },
        // Keyed on the request: it is marked SUBMITTED once, so this fires once
        // even if the upload is retried.
        dedupeKey: `document-uploaded-${request.id}`,
      });
    } catch (error) {
      log.failure(LogEvent.NOTIFICATION_DISPATCH_FAILED, error, {
        event: "document_uploaded_staff",
      });
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

    /*
      An access event, not an audit event.

      Downloads outnumber document state changes by orders of magnitude, and
      a firm's document timeline should not be buried under them. recordAccessEvent
      also dedupes repeat views inside its window, which is what stops a
      double-click producing two identical rows.
    */
    await recordAccessEvent({
      action: "document.downloaded",
      entityType: "document",
      entityId: id,
    }).catch(() => undefined);

    return signedUrl;
  };

  /**
   * One document's history, read from `audit_events`.
   *
   * Kept as its own endpoint rather than folded into `GET /audit-events`
   * despite reading the same table, because the two answer to different
   * permissions: this one is gated on holding ADMIN *on the document*, while
   * the firm-wide feed requires the `audit:read` grant that only owners and
   * admins have. Collapsing them would either hide a document's history from
   * the person who owns it or expose the firm-wide trail to everyone who owns
   * one document.
   *
   * Both change and access rows, newest first — a download is as much a part
   * of a document's history as a rename.
   */
  getActivityLogs = async (id: string, userId: string) => {
    await this.ensurePermission(id, userId, "ADMIN");

    return db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        category: auditEvents.category,
        summary: auditEvents.summary,
        metadata: auditEvents.metadata,
        actorName: auditEvents.actorName,
        actorEmail: auditEvents.actorEmail,
        actorId: auditEvents.actorId,
        ipAddress: auditEvents.ipAddress,
        userAgent: auditEvents.userAgent,
        createdAt: auditEvents.occurredAt,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "document"),
          eq(auditEvents.entityId, id),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));
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

  /**
   * Outstanding requests for the firm, optionally narrowed to one matter.
   *
   * Scoped by organization rather than by who raised the request: chasing a
   * client for a document is the matter's business, not one colleague's.
   */
  getExternalRequests = async (
    organizationId: string,
    filters?: { caseId?: string; leadId?: string; status?: DocumentRequestStatus },
  ) => {
    const conditions = [eq(documentRequests.organizationId, organizationId)];
    if (filters?.caseId) {
      conditions.push(eq(documentRequests.caseId, filters.caseId));
    }
    if (filters?.leadId) {
      conditions.push(eq(documentRequests.leadId, filters.leadId));
    }
    if (filters?.status) {
      conditions.push(eq(documentRequests.status, filters.status));
    }

    const rows = await db
      .select({
        id: documentRequests.id,
        caseId: documentRequests.caseId,
        leadId: documentRequests.leadId,
        recipientName: documentRequests.recipientName,
        recipientEmail: documentRequests.recipientEmail,
        requestedLabel: documentRequests.requestedLabel,
        message: documentRequests.message,
        status: documentRequests.status,
        expiresAt: documentRequests.expiresAt,
        createdAt: documentRequests.createdAt,
        requestedById: user.id,
        requestedByName: user.name,
        submissionCount: count(externalSubmissions.id),
      })
      .from(documentRequests)
      .leftJoin(user, eq(user.id, documentRequests.requestedByUserId))
      .leftJoin(
        externalSubmissions,
        eq(externalSubmissions.requestId, documentRequests.id),
      )
      .where(and(...conditions))
      .groupBy(documentRequests.id, user.id)
      .orderBy(desc(documentRequests.createdAt));

    return rows.map((row) => ({
      ...row,
      submissionCount: Number(row.submissionCount),
      requestedBy: row.requestedById
        ? { id: row.requestedById, name: row.requestedByName }
        : null,
    }));
  };

  cancelExternalRequest = async (id: string, organizationId: string, _userId: string) => {
    return db.transaction(async (tx) => {
      const [request] = await tx
        .update(documentRequests)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(documentRequests.id, id),
            eq(documentRequests.organizationId, organizationId),
            inArray(documentRequests.status, [
              "PENDING",
              "PARTIALLY_SUBMITTED",
            ]),
          ),
        )
        .returning();

      if (!request) throw new NotFoundError("Open document request not found");

      await recordAuditEvent({
        action: "document.access_revoked",
        entityType: "document_request",
        entityId: id,
        onWriteFailure: "log",
        summary: "Document request cancelled",
        metadata: { requestId: id, scope: "external_request" },
      });

      return request;
    });
  };
}
