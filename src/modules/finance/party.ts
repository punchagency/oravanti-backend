import { eq, sql } from "drizzle-orm";
import { clients } from "../../db/schema/clients";
import { invoices } from "../../db/schema/invoices";
import { leads } from "../../db/schema/leads";

/**
 * Who an invoice bills.
 *
 * An invoice is raised against a **lead** during intake and a **client** after
 * conversion, never both. That is not a convenience: consultation fees and fee
 * agreements are charged before a `clients` row exists, because `openCase` —
 * the only thing that creates one — is itself gated on the fee agreement being
 * paid. Billing the lead is what breaks that circle, and it is also the only
 * way to invoice someone who consults and then does not retain the firm.
 *
 * Every read of an invoice therefore left-joins both sides and coalesces. These
 * expressions exist so the four places that do it cannot drift into describing
 * the same invoice differently.
 */

/** `.leftJoin(clients, onClient).leftJoin(leads, onLead)` — one party will be null. */
export const onClient = eq(clients.id, invoices.clientId);
export const onLead = eq(leads.id, invoices.leadId);

/**
 * The billed party's name.
 *
 * `nullif(trim(...), '')` guards the case where a lead has blank names: the
 * concatenation would otherwise yield a lone space, and a row labelled " " is
 * worse than one labelled "Unnamed lead".
 */
export const partyName = sql<string>`coalesce(
  ${clients.displayName},
  nullif(trim(coalesce(${leads.firstName}, '') || ' ' || coalesce(${leads.lastName}, '')), ''),
  'Unnamed lead'
)`;

export const partyEmail = sql<string | null>`coalesce(${clients.email}, ${leads.email})`;

export const partyPhone = sql<string | null>`coalesce(${clients.phone}, ${leads.phone})`;

/** `"client"` once converted, `"lead"` while still in intake. */
export const partyType = sql<"client" | "lead">`CASE WHEN ${invoices.clientId} IS NOT NULL THEN 'client' ELSE 'lead' END`;

export type InvoiceParty = {
  type: "client" | "lead";
  id: string;
  name: string;
  email: string | null;
};

/** Assemble the party from a row that selected the pieces above. */
export const toParty = (row: {
  clientId: string | null;
  leadId: string | null;
  partyName: string;
  partyEmail: string | null;
}): InvoiceParty => ({
  type: row.clientId ? "client" : "lead",
  // One of the two is non-null by check constraint, so the fallback is
  // unreachable — it exists so the type is a plain string.
  id: row.clientId ?? row.leadId ?? "",
  name: row.partyName,
  email: row.partyEmail,
});
