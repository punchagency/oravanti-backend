import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";
import { leads } from "./leads";
import { staff } from "./staff";

export const aiScanJobStatusEnum = pgEnum("ai_scan_job_status", [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);

export const aiScanTriggerEnum = pgEnum("ai_scan_trigger", [
  "upload",
  "manual",
  "full_scan",
]);

/**
 * Source of truth for AI scan job status.
 *
 * Deliberately NOT read from BullMQ: `defaultJobOptions.removeOnComplete` is
 * one day, so Redis forgets completed jobs while the backend still needs to
 * report on them. Redis carries the work; Postgres carries the record.
 *
 * The unit of work is the SCENARIO (lead/case), not the document — cross-
 * document checks need every document at once, so per-document jobs would
 * force a fan-in barrier for no benefit.
 */
export const aiScanJobs = pgTable(
  "ai_scan_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),

    status: aiScanJobStatusEnum("status").notNull().default("queued"),
    trigger: aiScanTriggerEnum("trigger").notNull(),
    /** BullMQ job id — for cancellation and correlation, never for status. */
    queueJobId: text("queue_job_id"),
    requestedByStaffId: uuid("requested_by_staff_id").references(() => staff.id),

    documentCount: integer("document_count").notNull().default(0),
    /** How many documents were served from the analysis cache (no AI spend). */
    cachedCount: integer("cached_count").notNull().default(0),
    issuesFound: integer("issues_found").notNull().default(0),

    /**
     * Ties together the jobs a single full scan fans out into.
     *
     * A full scan enqueues one independent job per matter, so without this
     * there is no way to say what "the last scan" covered — the dashboard's
     * "N matters reviewed · N issues found" strip would have to guess from a
     * time window. Null for jobs triggered by an upload or a single re-run,
     * which are not part of a batch.
     */
    batchId: uuid("batch_id"),

    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    error: text("error"),
    /** Model/prompt versions the run used, for reproducibility. */
    runMetadata: jsonb("run_metadata").notNull().default({}),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "ai_scan_jobs_exactly_one_scenario",
      sql`(${table.leadId} IS NOT NULL)::int + (${table.caseId} IS NOT NULL)::int = 1`,
    ),
    // Coalescing: at most one in-flight job per scenario, so a bulk upload of
    // ten files produces one scan rather than ten.
    uniqueIndex("ai_scan_jobs_inflight_lead_unique")
      .on(table.leadId)
      .where(sql`${table.status} IN ('queued', 'running') AND ${table.leadId} IS NOT NULL`),
    uniqueIndex("ai_scan_jobs_inflight_case_unique")
      .on(table.caseId)
      .where(sql`${table.status} IN ('queued', 'running') AND ${table.caseId} IS NOT NULL`),
    index("ai_scan_jobs_organization_idx").on(table.organizationId),
    index("ai_scan_jobs_batch_idx").on(table.batchId),
    index("ai_scan_jobs_status_idx").on(table.status),
    // Drives the reconciliation sweep for jobs stuck in `running`.
    index("ai_scan_jobs_started_at_idx").on(table.startedAt),
  ],
);

export type AiScanJob = typeof aiScanJobs.$inferSelect;
export type NewAiScanJob = typeof aiScanJobs.$inferInsert;
