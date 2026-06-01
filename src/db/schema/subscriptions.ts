import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization } from './auth-schema';
import { practiceAreas } from "./practice-areas";

export enum SubscriptionStatus {
  ACTIVE = "active",
  PAST_DUE = "past_due",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.CANCELLED,
  SubscriptionStatus.EXPIRED,
]);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    organizationId: text("organization_id")
      .references(() => organization.id)
      .notNull(),

    practiceAreaId: uuid("practice_area_id")
      .references(() => practiceAreas.id)
      .notNull(),

    status: subscriptionStatusEnum("status").notNull(),

    billingCycle: varchar("billing_cycle", {
      length: 20,
    }).notNull(),

    startsAt: timestamp("starts_at").notNull(),

    expiresAt: timestamp("expires_at"),

    cancelledAt: timestamp("cancelled_at"),

    paymentProvider: varchar("payment_provider", {
      length: 50,
    }).notNull(),

    providerSubscriptionId: varchar("provider_subscription_id", {
      length: 255,
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_active_firm_practice_area_unique")
      .on(table.organizationId, table.practiceAreaId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
