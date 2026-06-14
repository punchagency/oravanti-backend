import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

export const emailProtocolEnum = pgEnum("email_protocol", [
  "imap",
  "pop3",
]);

export const emailProviderEnum = pgEnum("provider", [
  "google",
  "microsoft",
  "custom",
]);

export const emailDomainCache = pgTable("email_domain_cache", {
  id: uuid("id").defaultRandom().primaryKey(),
  domain: text("domain").unique().notNull(),
  provider: emailProviderEnum("provider").notNull(), // 'google' | 'microsoft' | 'custom'
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const emailDiscoveryCache = pgTable("email_discovery_cache", {
  id: uuid("id").defaultRandom().primaryKey(),
  domain: text("domain").unique().notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: text("smtp_port").notNull(),
  protocol: emailProtocolEnum("protocol").notNull(),
  receiveHost: text("receive_host").notNull(),
  receivePort: text("receive_port").notNull(),
  secure: boolean("secure").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const connectedEmailAccount = pgTable("connected_email_account", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  email: text("email").unique().notNull(),
  provider: emailProviderEnum("provider").notNull(), // 'google' | 'microsoft' | 'custom'

  // OAuth Tokens (Route A)
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),

  // SMTP/IMAP/POP3 Credentials (Route C - Encrypted)
  customSettings: jsonb("custom_settings").$type<{
    protocol: "imap" | "pop3";
    smtpHost: string;
    smtpPort: number;
    imapHost?: string;
    imapPort?: number;
    pop3Host?: string;
    pop3Port?: number;
    encryptedPassword?: string;
    iv?: string;
    tag?: string;
  }>(),

  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
