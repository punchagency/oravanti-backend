/**
 * Tier 2 — Postgres. Proves stuck webhook events are detected.
 *
 *   npm run check 18-webhook-staleness
 *
 * The failure this guards against is silent by construction: the HTTP path
 * returns 200, the event is claimed, and only the worker half is broken — so
 * nobody is waiting on a response to notice. The one signal is a row left at
 * `processed_at IS NULL`, and this proves something reads it.
 */
import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { paymentWebhookEvents } from "../../src/db/schema/payment-webhook-events";
import { findStaleWebhookEvents } from "../../src/modules/finance/confido/webhook-staleness";
import { check, checkEqual, report, section } from "./_bootstrap";

const RUN = randomUUID().slice(0, 8);
const ids: string[] = [];

const seed = async (eventId: string, receivedAt: Date, processed: boolean) => {
  ids.push(eventId);
  await systemDb.insert(paymentWebhookEvents).values({
    provider: "confido",
    eventId,
    eventType: "transaction.created",
    receivedAt,
    processedAt: processed ? new Date() : null,
  });
};

const main = async () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  try {
    section("a healthy queue reports nothing");

    const baseline = await findStaleWebhookEvents();
    check(
      "starting from a known count",
      typeof baseline.stale === "number",
      baseline,
    );

    section("an unhandled event past the threshold is found");

    await seed(`stale-${RUN}`, minutesAgo(30), false);
    const withStale = await findStaleWebhookEvents();
    checkEqual(
      "the stuck event is counted",
      withStale.stale,
      baseline.stale + 1,
    );
    check(
      "and its age is reported",
      (withStale.oldestMinutes ?? 0) >= 30,
      withStale.oldestMinutes,
    );

    section("what must NOT be reported");

    // Handling is a queue hop and one API call. An event received seconds ago
    // is in flight, not stuck, and alerting on it would train people to ignore
    // the alert.
    await seed(`fresh-${RUN}`, minutesAgo(1), false);
    const withFresh = await findStaleWebhookEvents();
    checkEqual(
      "an event still within the grace period is ignored",
      withFresh.stale,
      baseline.stale + 1,
    );

    // The whole point: a handled event is not stuck however old it is.
    await seed(`old-done-${RUN}`, minutesAgo(600), true);
    const withHandled = await findStaleWebhookEvents();
    checkEqual(
      "an old but handled event is ignored",
      withHandled.stale,
      baseline.stale + 1,
    );

    section("the threshold is honoured");

    // Proves the cutoff is doing the work rather than the count accidentally
    // agreeing: widen the window and the fresh event appears.
    const wide = await findStaleWebhookEvents(30 * 1000);
    checkEqual(
      "a shorter threshold catches the recent one too",
      wide.stale,
      baseline.stale + 2,
    );
  } finally {
    if (ids.length) {
      await systemDb
        .delete(paymentWebhookEvents)
        .where(inArray(paymentWebhookEvents.eventId, ids))
        .catch(() => {});
    }
  }

  await report();
};

main().catch(async (err) => {
  console.error("\x1b[31mCheck crashed:\x1b[0m", err);
  await report();
});
