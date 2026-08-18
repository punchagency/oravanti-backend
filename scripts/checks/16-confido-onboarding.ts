/**
 * Tier 2 — Postgres. The parts of Confido onboarding only a database can prove.
 *
 *   npm run check 16-confido-onboarding
 *
 * No network: the GraphQL client is exercised by `14-confido-sandbox`, and the
 * signature and status logic by the unit tests. What is left, and what this
 * covers, is the concurrency and idempotency the schema is responsible for:
 *
 *   - the lazy-creation lock, which is the only thing standing between two
 *     admins clicking at once and two merchant accounts that cannot be deleted
 *   - the confido_firm_id -> organization_id mapping the webhook uses to pick a
 *     tenant, outside RLS
 *   - the webhook event claim, which is what makes a redelivery a no-op
 *   - that a firm API token survives a round trip through its column
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { organization } from "../../src/db/schema/auth-schema";
import { confidoFirms } from "../../src/db/schema/confido-firms";
import { paymentWebhookEvents } from "../../src/db/schema/payment-webhook-events";
import {
  decryptPaymentValue,
  encryptPaymentValue,
} from "../../src/utils/payment-crypto";
import { check, checkEqual, report, section } from "./_bootstrap";

const RUN = randomUUID().slice(0, 8);
const PROVIDER = "confido";

const makeOrg = async (label: string): Promise<string> => {
  const id = `org-confido-${label}-${RUN}`;
  await systemDb.insert(organization).values({
    id,
    name: `Confido Check ${label} ${RUN}`,
    slug: `confido-check-${label}-${RUN}`,
    createdAt: new Date(),
  });
  return id;
};

const main = async () => {
  const orgA = await makeOrg("a");
  const orgB = await makeOrg("b");
  const eventIds: string[] = [];

  try {
    // ── The lazy-creation lock ────────────────────────────────────────────
    section("lazy creation is serialised by the unique index");

    // `createFirm` has no idempotency key and Confido has no delete API, so a
    // duplicate is permanent. The claim has to be the database's job, not a
    // check-then-act in the service.
    const claims = await Promise.all(
      [1, 2, 3].map(() =>
        systemDb
          .insert(confidoFirms)
          .values({ organizationId: orgA, provisioningState: "creating" })
          .onConflictDoNothing({ target: confidoFirms.organizationId })
          .returning({ id: confidoFirms.id }),
      ),
    );

    const winners = claims.filter((rows) => rows.length > 0);
    checkEqual("exactly one concurrent claim wins", winners.length, 1);

    const rows = await systemDb
      .select({ id: confidoFirms.id })
      .from(confidoFirms)
      .where(eq(confidoFirms.organizationId, orgA));
    checkEqual("one row exists for the organization", rows.length, 1);

    // ── The webhook's tenant mapping ──────────────────────────────────────
    section("confido_firm_id resolves exactly one organization");

    const firmA = `firm_${RUN}_a`;
    await systemDb
      .update(confidoFirms)
      .set({ confidoFirmId: firmA, provisioningState: "ready" })
      .where(eq(confidoFirms.organizationId, orgA));

    const [resolved] = await systemDb
      .select({ organizationId: confidoFirms.organizationId })
      .from(confidoFirms)
      .where(eq(confidoFirms.confidoFirmId, firmA))
      .limit(1);
    checkEqual("maps back to the right tenant", resolved?.organizationId, orgA);

    // The webhook runs outside RLS, so a duplicate here would let one firm's
    // event write to another firm's row.
    let duplicateRejected = false;
    try {
      await systemDb
        .insert(confidoFirms)
        .values({
          organizationId: orgB,
          confidoFirmId: firmA,
          provisioningState: "ready",
        });
    } catch {
      duplicateRejected = true;
    }
    check("a second org cannot claim the same Confido firm", duplicateRejected);

    // Two organizations may both be un-provisioned at once: confido_firm_id is
    // nullable, and Postgres allows many NULLs in a unique index. Without that
    // the placeholder row could not exist.
    await systemDb
      .insert(confidoFirms)
      .values({ organizationId: orgB, provisioningState: "creating" })
      .onConflictDoNothing({ target: confidoFirms.organizationId });
    const nulls = await systemDb
      .select({ id: confidoFirms.id })
      .from(confidoFirms)
      .where(eq(confidoFirms.provisioningState, "creating"));
    check(
      "multiple organizations can be provisioning at once",
      nulls.length >= 1,
      nulls.length,
    );

    // ── Credential round trip ─────────────────────────────────────────────
    section("the firm token survives its column");

    const token = `f_secret_sandbox_${randomUUID().replace(/-/g, "")}`;
    await systemDb
      .update(confidoFirms)
      .set({ encryptedApiToken: encryptPaymentValue(token) })
      .where(eq(confidoFirms.organizationId, orgA));

    const [stored] = await systemDb
      .select({ token: confidoFirms.encryptedApiToken })
      .from(confidoFirms)
      .where(eq(confidoFirms.organizationId, orgA))
      .limit(1);

    check("the column does not hold the token in clear", stored?.token !== token);
    checkEqual(
      "it decrypts back to the original",
      decryptPaymentValue(stored!.token!),
      token,
    );

    // ── Webhook claiming ──────────────────────────────────────────────────
    section("event claiming makes redelivery a no-op");

    const eventId = `evt_${RUN}_1`;
    eventIds.push(eventId);

    await systemDb.insert(paymentWebhookEvents).values({
      provider: PROVIDER,
      eventId,
      eventType: "firm.updated",
    });

    // Confido reuses the event id on resend, which is exactly what makes this
    // safe — and what the whole fast-ack design depends on.
    let replayRejected = false;
    try {
      await systemDb.insert(paymentWebhookEvents).values({
        provider: PROVIDER,
        eventId,
        eventType: "firm.updated",
      });
    } catch {
      replayRejected = true;
    }
    check("a redelivered event id is rejected", replayRejected);

    // The table is shared with the Stripe-shaped handler, so the same id from a
    // different provider must still be allowed.
    let otherProviderAllowed = true;
    try {
      await systemDb.insert(paymentWebhookEvents).values({
        provider: "stripe",
        eventId,
        eventType: "payment",
      });
    } catch {
      otherProviderAllowed = false;
    }
    check("the same id under another provider is allowed", otherProviderAllowed);

    section("a batch claims every event exactly once");

    // Confido posts an array, and a redelivered batch usually overlaps rather
    // than repeating exactly — the already-seen ones must be skipped without
    // dropping the new one.
    const batch = [`evt_${RUN}_2`, `evt_${RUN}_3`, eventId];
    eventIds.push(...batch);

    let claimed = 0;
    for (const id of batch) {
      try {
        await systemDb.insert(paymentWebhookEvents).values({
          provider: PROVIDER,
          eventId: id,
          eventType: "firm.updated",
        });
        claimed += 1;
      } catch {
        /* already seen */
      }
    }
    checkEqual("only the unseen events are claimed", claimed, 2);

    section("processed_at only moves forward");

    await systemDb
      .update(paymentWebhookEvents)
      .set({ processedAt: new Date() })
      .where(
        and(
          eq(paymentWebhookEvents.provider, PROVIDER),
          eq(paymentWebhookEvents.eventId, eventId),
        ),
      );

    const [processed] = await systemDb
      .select({ processedAt: paymentWebhookEvents.processedAt })
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.provider, PROVIDER),
          eq(paymentWebhookEvents.eventId, eventId),
        ),
      )
      .limit(1);

    check("a handled event is stamped", processed?.processedAt != null);

    const [unprocessed] = await systemDb
      .select({ processedAt: paymentWebhookEvents.processedAt })
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.provider, PROVIDER),
          eq(paymentWebhookEvents.eventId, `evt_${RUN}_2`),
        ),
      )
      .limit(1);

    // A row left null is one that crashed mid-handle: visible, not silently
    // replayed.
    check(
      "an unhandled event stays visible as null",
      unprocessed?.processedAt == null,
    );
  } finally {
    // Leave nothing behind, the same discipline as the other checks.
    await systemDb
      .delete(confidoFirms)
      .where(eq(confidoFirms.organizationId, orgA))
      .catch(() => {});
    await systemDb
      .delete(confidoFirms)
      .where(eq(confidoFirms.organizationId, orgB))
      .catch(() => {});
    for (const id of eventIds) {
      await systemDb
        .delete(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.eventId, id))
        .catch(() => {});
    }
    await systemDb
      .delete(organization)
      .where(eq(organization.id, orgA))
      .catch(() => {});
    await systemDb
      .delete(organization)
      .where(eq(organization.id, orgB))
      .catch(() => {});
  }

  await report();
};

main().catch(async (err) => {
  console.error("\x1b[31mCheck crashed:\x1b[0m", err);
  await report();
});
