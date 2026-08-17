import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * One organization's merchant account with Confido Legal.
 *
 * Deliberately its own table rather than columns on `organization`. That table
 * is Better Auth's: `auth-schema.ts` is rewritten wholesale by
 * `npm run auth:generate`, and its custom columns are declared in
 * `additionalFields` in `src/auth/index.ts` — several with `input: true`, which
 * makes them settable through the auth API. A merchant-account id and a
 * full-access financial credential belong in neither of those places.
 *
 * It also gives us the reverse lookup the webhook needs. Confido posts every
 * event for every firm to a single Partner-level URL identified only by
 * `firmId`, so `confido_firm_id -> organization_id` is the join that decides
 * which tenant an event belongs to. That path runs outside RLS, which is why
 * this index has to be unique and right.
 */
export const confidoFirms = pgTable(
  "confido_firms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    /**
     * Confido's Firm id. Null while provisioning: the row is inserted first to
     * claim the organization, and only then is the firm created remotely.
     * Postgres permits many NULLs in a unique index, which is exactly what that
     * placeholder needs.
     */
    confidoFirmId: text("confido_firm_id"),

    /**
     * The Firm API token, encrypted via `utils/payment-crypto`.
     *
     * Long-lived, unscoped and with no rotation endpoint — any valid firm token
     * can do anything the firm can. Never select this column into a response;
     * project columns explicitly, because a bare `select()` here would hand it
     * to the owning org's own frontend and RLS would not object.
     */
    encryptedApiToken: text("encrypted_api_token"),

    /**
     * Confido's `FirmStatus`, stored verbatim.
     *
     * `text` rather than a `pgEnum`, against the convention every other fixed set
     * in this schema follows. Confido added `DECLINED` in January 2026 and
     * `SUSPENDED` is not documented at all, so the set demonstrably grows without
     * notice. A Postgres enum would turn the next addition into a migration
     * emergency inside a webhook that has five seconds to answer before delivery
     * is marked failed. The TypeScript union plus a normalizer that preserves
     * unrecognised values gives the type safety without that failure mode.
     */
    status: text("status").notNull().default("CREATED"),

    /**
     * Confido's own operational flag, stored separately from `status` because
     * the two can disagree: `createFirm` returns a payload written before
     * activation lands. `status` is the narrative; this is the gate.
     */
    isAcceptingPayments: boolean("is_accepting_payments")
      .notNull()
      .default(false),

    /**
     * How the firm arrived: `embedded` (onboarding.js) or `connect` (an existing
     * Confido account authorising us). Support needs to know which, since only
     * one of them creates a Confido login for the firm.
     */
    onboardingMethod: text("onboarding_method"),

    /**
     * `creating` | `ready` | `failed`.
     *
     * `createFirm` is not idempotent and Confido has no idempotency key, so two
     * admins opening the settings page at once would create two firms with no
     * way to delete either. The unique index on `organization_id` is the lock —
     * `INSERT ... ON CONFLICT DO NOTHING` returning zero rows means someone else
     * won the race — and this column distinguishes "in flight" from "done" for
     * whoever lost it.
     */
    provisioningState: text("provisioning_state").notNull().default("creating"),

    /**
     * The firm's default trust and operating accounts, cached from
     * `bankAccountsList` so taking a payment does not need a round trip to
     * discover where the money goes.
     */
    defaultTrustBankAccountId: text("default_trust_bank_account_id"),
    defaultOperatingBankAccountId: text("default_operating_bank_account_id"),

    /** Set only on a successful `firmBrandingUpdate`, so a failure can be retried. */
    brandingAppliedAt: timestamp("branding_applied_at"),
    /** When the status was last confirmed against Confido, webhook or manual refresh. */
    statusCheckedAt: timestamp("status_checked_at"),
    /** Observability, mirroring `fee_agreements.lastWebhookEventAt`. */
    lastWebhookEventAt: timestamp("last_webhook_event_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One Confido Firm per legal entity, which is Confido's own guidance — not
    // one per attorney. This index is also the concurrency lock above.
    uniqueIndex("confido_firms_organization_uidx").on(table.organizationId),
    // The webhook's tenant resolution. A duplicate here would be a cross-tenant
    // financial write.
    uniqueIndex("confido_firms_confido_firm_uidx").on(table.confidoFirmId),
    index("confido_firms_status_idx").on(table.status),
  ],
);

export type ConfidoFirm = typeof confidoFirms.$inferSelect;
export type NewConfidoFirm = typeof confidoFirms.$inferInsert;
