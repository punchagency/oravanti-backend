import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * Per-firm switches for AI document review.
 *
 * Scoped to all practice areas — the previous `inaValidationActive` flag
 * (Immigration and Nationality Act) was a leftover from when this product was
 * immigration-only and has been dropped. Domain-specific rules now live in the
 * backend rules engine, versioned per rule, rather than behind a global boolean.
 */
export const aiSystemConfig = pgTable("ai_system_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),
  /** Master switch — disables scanning and issue generation entirely. */
  isActive: boolean("is_active").notNull().default(true),
  /** Compare fields across documents and against the matter's own record. */
  crossCheckingEnabled: boolean("cross_checking_enabled").notNull().default(true),
  /**
   * Compare photos between identity documents. Off by default: LLM face
   * matching is materially less reliable than field comparison, and its
   * findings are severity-capped and always routed to a human.
   */
  photoComparisonEnabled: boolean("photo_comparison_enabled")
    .notNull()
    .default(false),
  /**
   * Scan on upload. When false, scans run only when explicitly requested
   * (manual re-run or "Run full scan").
   */
  realtimeAnalysis: boolean("realtime_analysis").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AiSystemConfig = typeof aiSystemConfig.$inferSelect;
export type NewAiSystemConfig = typeof aiSystemConfig.$inferInsert;
