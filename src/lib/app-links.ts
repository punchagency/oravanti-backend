import { env } from "../config/env";

/**
 * URLs into the staff web app, for links in notifications and emails.
 *
 * These exist because the same handful of routes were being spelled out at nine
 * call sites across five services, and every one of them was wrong: they
 * carried an `/admin` prefix the frontend router has never had, so every link a
 * staff member followed from a notification 404'd. Nothing caught it — a link
 * is a string, and no test asserts where a string points.
 *
 * The rule for changing anything here: open
 * `oravanti/src/routers/admin/index.tsx` and confirm the route exists. Three of
 * the original nine pointed at pages that do not exist at all (`/tasks/:id`,
 * `/finance/invoices/:id`, a top-level `/my-tasks`), so stripping the prefix
 * alone would have swapped one 404 for another.
 */
const appUrl = (path: string) => `${env.FRONTEND_APP_URL}${path}`;

/** A lead's detail page. */
export const leadUrl = (leadId: string) => appUrl(`/leads/${leadId}`);

/**
 * The consultation stage of a lead's intake pipeline.
 *
 * Where the fee-agreement card lives — `fee_agreement` has no page of its own,
 * so anything about an agreement points here rather than at the lead overview.
 */
export const leadConsultationUrl = (leadId: string) =>
  appUrl(`/leads/${leadId}/consultation`);

/** A case's detail page. */
export const caseUrl = (caseId: string) => appUrl(`/cases/${caseId}`);

/**
 * The invoicing list, filtered to one invoice.
 *
 * There is no per-invoice route, so this is the closest thing to a deep link:
 * the tab reads `q` as its search box, and an invoice number is unique within a
 * firm. Takes the number rather than the id for that reason — the id matches
 * nothing a user can see.
 */
export const invoiceUrl = (invoiceNumber: string) =>
  appUrl(`/finance/invoicing?q=${encodeURIComponent(invoiceNumber)}`);

/**
 * Whichever of the two a record hangs off.
 *
 * Several tables carry a nullable `caseId` and a nullable `leadId` with a CHECK
 * that exactly one is set — `document_requests` and `tasks` both do. The
 * constraint makes this total, but only the database knows that, so expressing
 * it here is what keeps the call sites free of non-null assertions. A record
 * that somehow has neither lands on the lead list rather than on `/leads/null`,
 * which is what the old template literal produced.
 */
export const caseOrLeadUrl = (record: {
  caseId?: string | null;
  leadId?: string | null;
}) =>
  record.caseId
    ? caseUrl(record.caseId)
    : record.leadId
      ? leadUrl(record.leadId)
      : appUrl("/leads");

/**
 * The assignee's own task queue.
 *
 * Split by what the task hangs off, because the app splits it the same way and
 * there is no combined view. A task has exactly one of `caseId`/`leadId` — the
 * `tasks` table has a CHECK constraint saying so — so this is total.
 */
export const myTasksUrl = (task: { caseId?: string | null }) =>
  appUrl(task.caseId ? "/cases/my-tasks" : "/leads/my-tasks");
