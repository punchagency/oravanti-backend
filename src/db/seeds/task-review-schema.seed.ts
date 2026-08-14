import { sql } from "drizzle-orm";
import { db } from "../client";

/**
 * Creates the schema behind the unified task review flow.
 *
 * Normally this would be a drizzle migration, but `drizzle/migrations/` is
 * gitignored in this repo, so a migration file would never reach another
 * environment. Every statement is idempotent, matching the style of the
 * hand-written migrations, and can be re-run safely.
 *
 * Covers:
 *   - `rejected` on `lead_task_status` and `workflow_step_status`
 *   - `task_review_events` (the append-only review thread)
 *   - `intake_pipeline_templates` / `_steps` (the DB-backed intake checklist)
 */
export async function applyTaskReviewSchema() {
  // ─── Enum values ───────────────────────────────────────────────────────────
  // ADD VALUE IF NOT EXISTS cannot run inside a transaction block on older
  // Postgres, so these are issued as standalone statements.
  await db.execute(
    sql`ALTER TYPE "public"."lead_task_status" ADD VALUE IF NOT EXISTS 'rejected'`,
  );
  await db.execute(
    sql`ALTER TYPE "public"."workflow_step_status" ADD VALUE IF NOT EXISTS 'rejected'`,
  );

  // ─── Enums for the review thread ───────────────────────────────────────────
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."task_review_kind" AS ENUM('lead_task', 'case_step');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."task_review_action" AS ENUM('submitted', 'approved', 'rejected', 'reopened', 'assigned');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // ─── task_review_events ────────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "task_review_events" (
      "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "organization_id" text NOT NULL REFERENCES "organization"("id"),
      "task_kind"       "public"."task_review_kind" NOT NULL,
      "task_id"         uuid NOT NULL,
      "lead_id"         uuid,
      "case_id"         uuid,
      "action"          "public"."task_review_action" NOT NULL,
      "note"            text,
      "actor_id"        uuid REFERENCES "staff"("id"),
      "actor_name"      text,
      "created_at"      timestamp DEFAULT now() NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "task_review_events_task_idx"
      ON "task_review_events" ("task_kind", "task_id");
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "task_review_events_org_idx"
      ON "task_review_events" ("organization_id", "created_at");
  `);

  // ─── intake_pipeline_templates ─────────────────────────────────────────────
  // `organization_id` is nullable on purpose: the null row is the system
  // default every firm falls back to.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "intake_pipeline_templates" (
      "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "organization_id" text REFERENCES "organization"("id"),
      "name"            text NOT NULL,
      "description"     text,
      "is_active"       boolean DEFAULT true NOT NULL,
      "created_at"      timestamp DEFAULT now() NOT NULL,
      "updated_at"      timestamp DEFAULT now() NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "intake_pipeline_templates_org_idx"
      ON "intake_pipeline_templates" ("organization_id", "is_active");
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "intake_pipeline_template_steps" (
      "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "template_id"    uuid NOT NULL REFERENCES "intake_pipeline_templates"("id") ON DELETE CASCADE,
      "title"          text NOT NULL,
      "description"    text,
      "pipeline_stage" "public"."lead_pipeline_stage" NOT NULL,
      "order_index"    integer NOT NULL,
      "is_required"    boolean DEFAULT true NOT NULL,
      "created_at"     timestamp DEFAULT now() NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "intake_pipeline_template_steps_template_idx"
      ON "intake_pipeline_template_steps" ("template_id", "pipeline_stage", "order_index");
  `);

  console.log("Task review + intake pipeline schema applied.");
}
