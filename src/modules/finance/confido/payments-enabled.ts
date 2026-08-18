import { eq } from "drizzle-orm";
import { systemDb } from "../../../db/client";
import { confidoFirms } from "../../../db/schema/confido-firms";
import { isConfidoConfigured } from "./confido.client";
import { canAcceptPayments } from "./firm-status";

/**
 * Whether a specific organization can take money right now.
 *
 * Replaces `isPaymentProviderConfigured()`, which answered a different and now
 * wrong question. That flag was global — one deployment-wide boolean read off
 * `STRIPE_SECRET_KEY` — because Stripe would have been a single platform
 * account. Confido credentials are per firm: each organization has its own
 * merchant account, its own API token, and its own underwriting status. One
 * firm being ready says nothing about the next.
 *
 * Two conditions, and both are required:
 *
 *   1. the platform has Confido credentials at all, and
 *   2. this firm has completed underwriting and Confido is accepting payments
 *      for it — `canAcceptPayments`, which insists on ACTIVE *and* the
 *      operational flag because the spike found a payload where they disagreed.
 *
 * Reads through `systemDb` with an explicit organization predicate. The callers
 * that matter most — the public payment page and the webhook worker — have no
 * request context, so the `db` proxy would silently fall back to `systemDb`
 * anyway; doing it explicitly means the query is honest about having no tenancy
 * rather than looking like it has some.
 */
export const paymentsEnabledFor = async (
  organizationId: string,
): Promise<boolean> => {
  if (!isConfidoConfigured()) return false;

  const [row] = await systemDb
    .select({
      status: confidoFirms.status,
      isAcceptingPayments: confidoFirms.isAcceptingPayments,
    })
    .from(confidoFirms)
    .where(eq(confidoFirms.organizationId, organizationId))
    .limit(1);

  if (!row) return false;
  return canAcceptPayments(row.status, row.isAcceptingPayments);
};
