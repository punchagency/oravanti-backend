import "dotenv/config";
import { runAuditRetention } from "../src/modules/shared/audit-retention.service";

/**
 * One retention pass, on demand.
 *
 * The worker process runs this on a schedule; this entry point exists so it can
 * be run deliberately — after first configuring the maintenance role, when
 * draining a backlog, or from a platform cron instead of the worker.
 *
 *   npm run audit:retention
 *
 * Requires `MAINTENANCE_DATABASE_URL` to point at a connection using the
 * `oravanti_maintenance` role created by `npm run security:baseline`. Without
 * it the job reports that it was skipped and exits non-zero rather than
 * quietly doing nothing — see the note in the service about why it must never
 * fall back to the application connection.
 */
const main = async () => {
  const summary = await runAuditRetention();

  if (!summary) {
    console.error(
      "[retention] no pass ran. Set MAINTENANCE_DATABASE_URL to a connection using the\n" +
        "            oravanti_maintenance role, created by `npm run security:baseline`.",
    );
    process.exit(1);
  }

  console.log(
    `[retention] ${summary.organizations} organizations · ` +
      `${summary.auditDeleted} change rows · ${summary.accessDeleted} access rows removed`,
  );

  if (summary.moreRemaining) {
    console.log("[retention] a pass hit the per-run cap — run again to continue draining");
  }
};

main().catch((err) => {
  console.error("[retention] failed:", err);
  process.exit(1);
});
