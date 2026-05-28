import { and, count, desc, eq, gte } from "drizzle-orm";
import { aiErrorFlags } from "../../db/schema/ai-error-flags";
import { aiSystemConfig } from "../../db/schema/ai-system-config";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { db } from "./../../db/client";

export class AIErrorDetectionService {
  // ─── Stats ────────────────────────────────────────────────────────────────────

  getStats = async (firmId: string) => {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [detectedThisMonth] = await db
      .select({ total: count() })
      .from(aiErrorFlags)
      .where(
        and(
          eq(aiErrorFlags.firmId, firmId),
          gte(aiErrorFlags.createdAt, startOfMonth),
        ),
      );

    const [prevented] = await db
      .select({ total: count() })
      .from(aiErrorFlags)
      .where(
        and(
          eq(aiErrorFlags.firmId, firmId),
          eq(aiErrorFlags.status, "resolved"),
        ),
      );

    return {
      errorsDetectedThisMonth: Number(detectedThisMonth.total),
      errorsPrevented: Number(prevented.total),
      avgDetectionTime: "< 2 min", // placeholder — update when AI service reports timing
      errorRateReduction: "34%", // placeholder — update when AI service reports metrics
    };
  };

  // ─── List Flags ───────────────────────────────────────────────────────────────

  getAllFlags = async (
    firmId: string,
    filters?: { severity?: string; status?: string },
  ) => {
    const rows = await db
      .select({
        id: aiErrorFlags.id,
        title: aiErrorFlags.title,
        description: aiErrorFlags.description,
        severity: aiErrorFlags.severity,
        status: aiErrorFlags.status,
        affectedField: aiErrorFlags.affectedField,
        documentRef: aiErrorFlags.documentRef,
        caseId: aiErrorFlags.caseId,
        documentId: aiErrorFlags.documentId,
        createdAt: aiErrorFlags.createdAt,
        clientId: clients.id,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
        caseType: cases.caseType,
      })
      .from(aiErrorFlags)
      .leftJoin(clients, eq(clients.id, aiErrorFlags.clientId))
      .leftJoin(cases, eq(cases.id, aiErrorFlags.caseId))
      .where(eq(aiErrorFlags.firmId, firmId))
      .orderBy(desc(aiErrorFlags.createdAt));

    return rows
      .filter((r) => {
        if (filters?.severity && r.severity !== filters.severity) return false;
        if (filters?.status && r.status !== filters.status) return false;
        return true;
      })
      .map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        severity: r.severity,
        status: r.status,
        affectedField: r.affectedField,
        documentRef: r.documentRef,
        caseId: r.caseId,
        documentId: r.documentId,
        createdAt: r.createdAt,
        client: { id: r.clientId, name: `${r.clientFirst} ${r.clientLast}` },
        caseType: r.caseType,
      }));
  };

  // ─── Get One ──────────────────────────────────────────────────────────────────

  getFlagById = async (id: string, firmId: string) => {
    const [row] = await db
      .select()
      .from(aiErrorFlags)
      .where(and(eq(aiErrorFlags.id, id), eq(aiErrorFlags.firmId, firmId)));
    return row ?? null;
  };

  // ─── Update Status ────────────────────────────────────────────────────────────

  updateFlagStatus = async (
    id: string,
    firmId: string,
    status: "pending_review" | "under_review" | "resolved",
    resolvedById?: string,
  ) => {
    const [updated] = await db
      .update(aiErrorFlags)
      .set({
        status,
        resolvedById: status === "resolved" ? resolvedById : null,
        resolvedAt: status === "resolved" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(aiErrorFlags.id, id), eq(aiErrorFlags.firmId, firmId)))
      .returning();
    return updated;
  };

  // ─── Create Flag (called by AI service) ──────────────────────────────────────

  createFlag = async (
    firmId: string,
    data: {
      clientId: string;
      caseId: string;
      documentId?: string;
      title: string;
      description: string;
      severity: "critical" | "high" | "medium" | "low";
      affectedField?: string;
      documentRef?: string;
    },
  ) => {
    // TODO: hook into AI service call here when admin AI is built
    const [flag] = await db
      .insert(aiErrorFlags)
      .values({ firmId, ...data })
      .returning();
    return flag;
  };

  // ─── System Config ────────────────────────────────────────────────────────────

  getSystemConfig = async (firmId: string) => {
    const [config] = await db
      .select()
      .from(aiSystemConfig)
      .where(eq(aiSystemConfig.firmId, firmId));

    if (config) return config;

    // seed default config on first access
    const [created] = await db
      .insert(aiSystemConfig)
      .values({ firmId })
      .returning();
    return created;
  };

  updateSystemConfig = async (
    firmId: string,
    data: Partial<typeof aiSystemConfig.$inferInsert>,
  ) => {
    const existing = await this.getSystemConfig(firmId);

    const [updated] = await db
      .update(aiSystemConfig)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(aiSystemConfig.firmId, firmId))
      .returning();
    return updated;
  };
}
