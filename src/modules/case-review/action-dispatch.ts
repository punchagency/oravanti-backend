/**
 * Performs the side effect behind a contextual action.
 *
 * The vocabulary and which actions each issue offers live in `actions.ts`; this
 * file is only the "what happens when you click it" half. Each handler reuses an
 * existing primitive (email, a lead task, a calendar event) rather than a
 * case-review-specific one.
 *
 * Effects that outgrow this — a real reminder cadence, attorney routing for
 * cases once a case task table exists — should replace a handler here, not add
 * branching to the caller.
 */
import { and, count, eq } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { organization } from "../../db/schema/auth-schema";
import { calendarEvents } from "../../db/schema/calendar-events";
import { caseIssueDocuments, caseIssues } from "../../db/schema/case-issues";
import { clients } from "../../db/schema/clients";
import { scenarioDocumentRequirements } from "../../db/schema/document-requirements";
import { leadTasks } from "../../db/schema/lead-tasks";
import { leads } from "../../db/schema/leads";
import { questionnaireResponseFiles } from "../../db/schema/questionnaires";
import { caseWorkflowSteps } from "../../db/schema/workflow";
import { BadRequestError } from "../../utils/error/app-error";
import { emailService } from "../../utils/email/email.service";
import { generateDocumentRequestEmailTemplate } from "../../utils/email/email.types";
import { DocumentsService } from "../documents/documents.service";
import { getFirmLanguage } from "../settings/consultation/consultation-settings.service";
import { WorkflowService } from "../workflow/workflow.service";
import type { ActionDef } from "./actions";
import { renderIssue } from "./render";

type IssueRow = typeof caseIssues.$inferSelect;

/**
 * Collaborators the dispatch depends on, injected so a check can drive the real
 * handlers with a fake mailer instead of sending mail.
 */
export type DocumentRequestInput = {
  organizationId: string;
  actorUserId: string;
  leadId?: string;
  caseId?: string;
  recipientEmail: string;
  recipientName?: string;
  requestedLabel: string;
  expiresAt: Date;
};

export type ActionDeps = {
  sendEmail: (opts: { to: string; subject: string; html: string }) => Promise<void>;
  /** Creates the tracked request and returns the raw upload token. */
  createDocumentRequest: (
    input: DocumentRequestInput,
  ) => Promise<{ token: string }>;
};

const documentsService = new DocumentsService();
const workflowService = new WorkflowService();

export const defaultActionDeps: ActionDeps = {
  // Discards the provider message id the mailer now returns: this port is a
  // fire-and-forget seam that fakes are written against, and widening it would
  // make every test double invent an id it has no use for.
  sendEmail: async (opts) => {
    await emailService.sendEmail(opts);
  },
  createDocumentRequest: (input) =>
    documentsService.createExternalRequest(input.organizationId, input.actorUserId, {
      leadId: input.leadId,
      caseId: input.caseId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName,
      requestedLabel: input.requestedLabel,
      expiresAt: input.expiresAt,
    }),
};

/**
 * How long a client has to act on a requested document. Long enough that a
 * reminder does not expire before someone gets to their post.
 */
const REQUEST_EXPIRY_DAYS = 14;

/** Where a navigate action should take the user; no effect is performed. */
export type NavigateResult = {
  kind: "navigate";
  target: "case" | "document";
  scenario: { type: "lead" | "case"; id: string };
};

export type MutationResult = { kind: "mutation" };

export type DispatchResult = NavigateResult | MutationResult;

/** Resolve the client/lead email an outbound action should reach. */
const resolveRecipientEmail = async (issue: IssueRow): Promise<string> => {
  if (issue.leadId) {
    const [row] = await db
      .select({ email: leads.email })
      .from(leads)
      .where(eq(leads.id, issue.leadId))
      .limit(1);
    if (row?.email) return row.email;
  } else if (issue.clientId) {
    const [row] = await db
      .select({ email: clients.email })
      .from(clients)
      .where(eq(clients.id, issue.clientId))
      .limit(1);
    if (row?.email) return row.email;
  }
  throw new BadRequestError("This matter has no contact email to reach");
};

const notify = async (
  deps: ActionDeps,
  issue: IssueRow,
  subject: string,
  body: string,
) => {
  const to = await resolveRecipientEmail(issue);
  await deps.sendEmail({
    to,
    subject,
    html: `<p>${body}</p>`,
  });
};

/** The recipient's name and the firm's, for addressing an outbound email. */
const resolveRecipient = async (issue: IssueRow) => {
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, issue.organizationId))
    .limit(1);

  let name: string | null = null;
  if (issue.leadId) {
    const [row] = await db
      .select({ first: leads.firstName })
      .from(leads)
      .where(eq(leads.id, issue.leadId))
      .limit(1);
    name = row?.first ?? null;
  } else if (issue.clientId) {
    const [row] = await db
      .select({ first: clients.firstName })
      .from(clients)
      .where(eq(clients.id, issue.clientId))
      .limit(1);
    name = row?.first ?? null;
  }
  return { recipientName: name, firmName: org?.name ?? "Your legal team" };
};

/**
 * What the issue is asking the client for, in their words.
 *
 * Both come off the issue itself — the rules snapshot the document title (or the
 * requirement's label, for a document that was never uploaded) into
 * `templateParams`, and `renderIssue` already produces localised prose. Writing
 * fresh copy here would mean two descriptions of the same finding drifting apart.
 */
const requestSubject = (issue: IssueRow, language: string) => {
  const params = (issue.templateParams ?? {}) as Record<string, unknown>;
  const label =
    typeof params.documentTitle === "string"
      ? params.documentTitle
      : typeof params.label === "string"
        ? params.label
        : "A document for your matter";
  const rendered = renderIssue(issue.templateKey, params as never, language);
  return { label, reason: rendered.description || rendered.title };
};

/**
 * Ask the client for a document: a tracked request plus an email carrying the
 * upload link. Without the request there is nothing for the client to act on and
 * nothing for the firm to chase.
 */
const requestDocument = async (
  deps: ActionDeps,
  issue: IssueRow,
  actorUserId: string | undefined,
  subject: string,
) => {
  if (!actorUserId) {
    throw new BadRequestError("Only a signed-in user can request a document");
  }
  const to = await resolveRecipientEmail(issue);
  const language = await getFirmLanguage(issue.organizationId);
  const { recipientName, firmName } = await resolveRecipient(issue);
  const { label, reason } = requestSubject(issue, language);

  const expiresAt = new Date(
    Date.now() + REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  const { token } = await deps.createDocumentRequest({
    organizationId: issue.organizationId,
    actorUserId,
    leadId: issue.leadId ?? undefined,
    caseId: issue.leadId ? undefined : (issue.caseId ?? undefined),
    recipientEmail: to,
    recipientName: recipientName ?? undefined,
    requestedLabel: label,
    expiresAt,
  });

  await deps.sendEmail({
    to,
    subject,
    html: generateDocumentRequestEmailTemplate({
      recipientName,
      firmName,
      requestedLabel: label,
      reason,
      uploadLink: `${env.FRONTEND_APP_URL}/document-upload/${token}`,
      expiresAt,
    }),
  });
};

/**
 * The stages a lead task may sit under.
 *
 * The DB enum has six values, but the task-creation surface accepts five —
 * `lead_inbox` is rejected by the leads validation schema and by
 * `LeadWorkflowService.createTask`. Anything derived here must land in these.
 */
type TaskStage =
  | "conflict_check"
  | "questionnaire"
  | "consultation"
  | "fee_agreement"
  | "case_opening";

/**
 * Which stage a task raised from `issue` belongs under.
 *
 * `pipelineStage` is a bucket for what the work is *about*, not where the lead
 * currently is — `initializePipelineSteps` stamps every intake task up front
 * while the lead still sits at `conflict_check`, and the consultation flow reads
 * tasks back by stage. So an issue over documents that arrived through a
 * questionnaire belongs on `questionnaire`, whatever the lead is doing now.
 *
 * Derived here rather than at detection time so the rules engine and every
 * already-detected issue stay untouched.
 */
const deriveTaskStage = async (issue: IssueRow): Promise<TaskStage> => {
  // 1. Requirement-driven issues (missing document, deadline approaching) name
  //    the requirement that raised them, which records where it came from.
  const requirementId = (issue.facts as Record<string, unknown> | null)
    ?.requirementId;
  if (typeof requirementId === "string") {
    const [requirement] = await db
      .select({ source: scenarioDocumentRequirements.source })
      .from(scenarioDocumentRequirements)
      .where(eq(scenarioDocumentRequirements.id, requirementId))
      .limit(1);
    if (requirement?.source === "questionnaire") return "questionnaire";
  }

  // 2. Document-driven issues: did any of the documents arrive via a
  //    questionnaire? (Indexed on document_id, so this is a cheap lookup.)
  const [viaQuestionnaire] = await db
    .select({ id: questionnaireResponseFiles.id })
    .from(caseIssueDocuments)
    .innerJoin(
      questionnaireResponseFiles,
      eq(questionnaireResponseFiles.documentId, caseIssueDocuments.documentId),
    )
    .where(eq(caseIssueDocuments.issueId, issue.id))
    .limit(1);
  if (viaQuestionnaire) return "questionnaire";

  // 3. Nothing tied it to a stage — put it where the lead is, clamping the one
  //    DB value the task surface will not accept.
  const [lead] = await db
    .select({ stage: leads.pipelineStage })
    .from(leads)
    .where(eq(leads.id, issue.leadId!))
    .limit(1);
  return lead?.stage && lead.stage !== "lead_inbox"
    ? lead.stage
    : "conflict_check";
};

/**
 * Route a case issue to an attorney by assigning the case's current workflow
 * step. Cases have no task table — work on a case *is* a workflow step, so the
 * case equivalent of "create a task for an attorney" is "give them the step".
 *
 * "Current" is the in-progress step; a case that has not started one (freshly
 * opened, or every step still pending) falls back to the earliest incomplete
 * step, which assigning also starts.
 */
const assignCaseWorkflowStep = async (
  issue: IssueRow,
  assigneeStaffId: string,
  actorStaffId: string | undefined,
) => {
  const steps = await db
    .select({
      id: caseWorkflowSteps.id,
      status: caseWorkflowSteps.status,
      orderIndex: caseWorkflowSteps.orderIndex,
    })
    .from(caseWorkflowSteps)
    .where(eq(caseWorkflowSteps.caseId, issue.caseId!))
    .orderBy(caseWorkflowSteps.orderIndex);

  const target =
    steps.find((s) => s.status === "in_progress") ??
    // A rejected step is unfinished work, not a finished one — without it a
    // case whose only open step was sent back reports "already finished".
    steps.find((s) => s.status === "rejected") ??
    steps.find((s) => s.status === "pending");

  if (!target) {
    throw new BadRequestError(
      steps.length === 0
        ? "This case has no workflow steps to assign"
        : "Every workflow step on this case is already finished",
    );
  }

  // Through the service rather than a direct update, so the assignment is
  // org-checked and lands in the step action log like any other.
  await workflowService.assignStep(
    issue.caseId!,
    target.id,
    assigneeStaffId,
    issue.organizationId,
    undefined,
    actorStaffId,
  );
};

/** Create a lead task carrying the issue, for the attorney-routing actions. */
const createLeadTask = async (
  issue: IssueRow,
  assigneeStaffId: string | undefined,
  title: string,
) => {
  if (!issue.leadId) {
    // Should be unreachable: the registry only offers these on lead issues.
    throw new BadRequestError("Task actions apply to lead-stage matters only");
  }
  const pipelineStage = await deriveTaskStage(issue);

  // Append within the stage: orderIndex is a per-stage ordinal, not a global
  // one (initializePipelineSteps restarts it at 0 for each stage).
  const [{ n }] = await db
    .select({ n: count() })
    .from(leadTasks)
    .where(
      and(
        eq(leadTasks.leadId, issue.leadId),
        eq(leadTasks.pipelineStage, pipelineStage),
      ),
    );

  await db.insert(leadTasks).values({
    organizationId: issue.organizationId,
    leadId: issue.leadId,
    title,
    description: "Raised by AI case review.",
    orderIndex: Number(n),
    pipelineStage,
    assignedToId: assigneeStaffId ?? null,
    assignedAt: assigneeStaffId ? new Date() : null,
  });
};

/** Create a case-scoped calendar reminder for the set-calendar-alert action. */
const createCalendarAlert = async (issue: IssueRow, title: string) => {
  if (!issue.caseId) {
    throw new BadRequestError("Calendar alerts apply to open cases only");
  }
  await db.insert(calendarEvents).values({
    organizationId: issue.organizationId,
    eventType: "filing_deadline",
    title,
    // A placeholder time the reviewer edits in the calendar; the point is the
    // reminder exists and is linked to the matter.
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
    caseId: issue.caseId,
    clientId: issue.clientId ?? null,
    isAutoGenerated: true,
    notes: "Created from AI case review",
  });
};

/**
 * Run the effect for `action` against `issue`. Navigate actions return where to
 * go and touch nothing. The caller records the event and moves the issue to
 * under_review.
 *
 * `assigneeStaffId` is the attorney the caller chose (already validated as
 * eligible), not the staff member performing the action — assigning work to
 * whoever happened to click the button was the bug this replaced.
 */
export type DispatchContext = {
  /** The chosen attorney, for actions that route work. */
  assigneeStaffId?: string;
  /** Who is acting, as a staff id — recorded on the step action log. */
  staffId?: string;
  /** Who is acting, as a user id — a document request records its requester. */
  actorUserId?: string;
};

export const dispatchAction = async (
  deps: ActionDeps,
  issue: IssueRow,
  action: ActionDef,
  ctx: DispatchContext,
): Promise<DispatchResult> => {
  if (action.kind === "navigate") {
    return {
      kind: "navigate",
      target: action.target ?? "case",
      scenario: issue.leadId
        ? { type: "lead", id: issue.leadId }
        : { type: "case", id: issue.caseId! },
    };
  }

  switch (action.key) {
    case "request_reupload":
      await requestDocument(
        deps,
        issue,
        ctx.actorUserId,
        "A document needs to be re-uploaded",
      );
      break;
    case "send_client_reminder":
      await requestDocument(
        deps,
        issue,
        ctx.actorUserId,
        "Reminder: a document is still needed",
      );
      break;
    case "send_urgent_reminder": {
      // A nudge, not a new request — the client already has a link from
      // whichever action opened the request.
      const language = await getFirmLanguage(issue.organizationId);
      const { label } = requestSubject(issue, language);
      await notify(
        deps,
        issue,
        "Urgent: action needed on your matter",
        `${label} is still outstanding and is now time-sensitive. Please use the upload link we sent you as soon as possible.`,
      );
      break;
    }
    case "assign_to_attorney":
    case "escalate_to_attorney":
    case "flag_for_attorney":
      // Same intent, different idiom per matter type.
      if (issue.caseId) {
        await assignCaseWorkflowStep(
          issue,
          ctx.assigneeStaffId!,
          ctx.staffId,
        );
      } else {
        await createLeadTask(
          issue,
          ctx.assigneeStaffId,
          `Attorney review: ${action.label}`,
        );
      }
      break;
    case "request_postponement":
      await createLeadTask(
        issue,
        ctx.assigneeStaffId,
        "Request deadline postponement",
      );
      break;
    case "set_calendar_alert":
      await createCalendarAlert(issue, "AI review: deadline alert");
      break;
    default:
      throw new BadRequestError(`Action ${action.key} has no handler`);
  }

  return { kind: "mutation" };
};

/** Guard: the issue exists and belongs to the org. */
export const loadIssueForAction = async (
  organizationId: string,
  id: string,
): Promise<IssueRow | undefined> => {
  const [row] = await db
    .select()
    .from(caseIssues)
    .where(and(eq(caseIssues.id, id), eq(caseIssues.organizationId, organizationId)))
    .limit(1);
  return row;
};
