import { and, eq, isNotNull } from "drizzle-orm";
import { systemDb } from "../db/client";
import { user } from "../db/schema/auth-schema";
import { clients } from "../db/schema/clients";
import { leads } from "../db/schema/leads";
import { staff } from "../db/schema/staff";
import type { NotificationRecipient, ResolvedRecipient } from "./types";

/**
 * Turn "lead 123" into a name, an address, and a consent state.
 *
 * Queries go through `systemDb` with an explicit organizationId predicate
 * rather than the `db` proxy. Every caller of this module runs in a worker,
 * where no AsyncLocalStorage request context exists and `db` would silently
 * fall back to systemDb anyway — this makes the tenant scoping visible in the
 * query instead of depending on a context that is not there. It is option 3 in
 * src/db/client.ts's own header.
 */

/**
 * Staff and users carry no SMS consent columns, and that is deliberate rather
 * than an omission: consent law governs messages to consumers, and a staff
 * member's number is in the system because they work here. Their events are all
 * email and in-app anyway (see staff.templates.ts).
 */
const NO_SMS_CONSENT = { smsConsent: false, smsOptOutAt: null } as const;

export const resolveRecipient = async (
  organizationId: string,
  recipient: NotificationRecipient,
): Promise<ResolvedRecipient | null> => {
  switch (recipient.type) {
    case "lead": {
      const [row] = await systemDb
        .select()
        .from(leads)
        .where(
          and(eq(leads.id, recipient.id), eq(leads.organizationId, organizationId)),
        )
        .limit(1);
      if (!row) return null;

      return {
        type: "lead",
        id: row.id,
        name: `${row.firstName} ${row.lastName}`.trim(),
        email: row.email,
        rawPhone: row.phone,
        smsConsent: row.smsConsent,
        smsOptOutAt: row.smsOptOutAt,
      };
    }

    case "client": {
      const [row] = await systemDb
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.id, recipient.id),
            eq(clients.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!row) return null;

      return {
        type: "client",
        id: row.id,
        name: row.displayName,
        email: row.email,
        rawPhone: row.phone,
        smsConsent: row.smsConsent,
        smsOptOutAt: row.smsOptOutAt,
      };
    }

    case "staff": {
      const [row] = await systemDb
        .select()
        .from(staff)
        .where(
          and(eq(staff.id, recipient.id), eq(staff.organizationId, organizationId)),
        )
        .limit(1);
      if (!row) return null;

      return {
        type: "staff",
        id: row.id,
        name: `${row.firstName} ${row.lastName}`.trim(),
        email: row.email,
        rawPhone: row.phone,
        ...NO_SMS_CONSENT,
      };
    }

    case "user": {
      const [row] = await systemDb
        .select()
        .from(user)
        .where(eq(user.id, recipient.id))
        .limit(1);
      if (!row) return null;

      return {
        type: "user",
        // `user.id` is text (Better Auth), while notifications.recipientId is a
        // uuid column. Left null rather than coerced — the address and name are
        // what a delivery record needs, and an invalid uuid would fail the
        // insert for every auth-adjacent notification.
        id: null,
        name: row.name ?? row.email,
        email: row.email,
        // The Better Auth `user` table carries no phone column — only
        // `organization` does. Users are reachable by email only, which suits
        // the auth-adjacent events this type exists for.
        rawPhone: null,
        ...NO_SMS_CONSENT,
      };
    }

    case "external":
      return {
        type: "external",
        id: null,
        name: recipient.name ?? recipient.email ?? "",
        email: recipient.email ?? null,
        rawPhone: recipient.phone ?? null,
        // An address with no row behind it cannot be consent-checked, so it can
        // never clear the SMS gate. Email-only by construction.
        ...NO_SMS_CONSENT,
      };
  }
};

/**
 * Every staff member at a firm who can receive an alert.
 *
 * Used by staff-audience events that have no more specific recipient than "the
 * firm" — a new lead arriving belongs to nobody yet.
 *
 * Filtered two ways. Rows without an email produce nothing but a `no_address`
 * skip for every alert the firm ever fires. Rows that are not `active` are
 * people who left, are on leave, or never accepted their invitation — mailing
 * them is at best noise and at worst sending client details to a former
 * employee's inbox.
 */
export const staffRecipientsForFirm = async (
  organizationId: string,
): Promise<NotificationRecipient[]> => {
  const rows = await systemDb
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
        isNotNull(staff.email),
      ),
    );

  return rows.map((row) => ({ type: "staff" as const, id: row.id }));
};
