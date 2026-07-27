/**
 * Contextual actions offered on an issue.
 *
 * The API declares which actions an issue supports and the UI renders whatever
 * it receives, rather than the frontend keeping its own issueType → buttons
 * map. Same reasoning as read-time prose in `render.ts`: the backend owns
 * presentation, so a new rule ships its buttons with it instead of waiting on a
 * matching frontend release.
 *
 * Dispatch lives in `action-dispatch.ts`; this file is the vocabulary.
 */

export type ActionVariant = "primary" | "secondary";
export type ActionKind = "mutation" | "navigate";
export type ScenarioType = "lead" | "case";

export type ActionDef = {
  key: string;
  /** Button label. */
  label: string;
  /**
   * Past-tense outcome, shown as the resolution log's "Action taken" pill —
   * "Request re-upload" becomes "Re-upload requested".
   */
  pastLabel: string;
  variant: ActionVariant;
  kind: ActionKind;
  /**
   * Which matter types this action is offered on.
   *
   * The dispatch targets are not uniform — email works for leads and cases,
   * calendar events are case-scoped, tasks are lead-scoped — so most actions
   * are only offered where their effect can run. A few (see `stubScenarios`)
   * are offered ahead of their implementation because the product wants the
   * button visible.
   */
  scenarios: ScenarioType[];
  /**
   * The subset of `scenarios` where the effect is not built yet. The action is
   * still offered there, but flagged `stub` so the UI can render it as
   * "not yet available", and dispatch refuses to fake it.
   */
  stubScenarios?: ScenarioType[];
  /** Where a `navigate` action points, relative to the issue's scenario. */
  target?: "case" | "document";
};

const BOTH: ScenarioType[] = ["lead", "case"];

const A = (def: ActionDef) => def;

// ── Vocabulary ───────────────────────────────────────────────────────────────

const REQUEST_REUPLOAD = A({
  key: "request_reupload",
  label: "Request re-upload",
  pastLabel: "Re-upload requested",
  variant: "primary",
  kind: "mutation",
  scenarios: BOTH,
});

const SEND_CLIENT_REMINDER = A({
  key: "send_client_reminder",
  label: "Send client reminder",
  pastLabel: "Reminder sent",
  variant: "primary",
  kind: "mutation",
  scenarios: BOTH,
});

const SEND_URGENT_REMINDER = A({
  key: "send_urgent_reminder",
  label: "Send urgent reminder",
  pastLabel: "Urgent reminder sent",
  variant: "primary",
  kind: "mutation",
  scenarios: BOTH,
});

const ESCALATE_TO_ATTORNEY = A({
  key: "escalate_to_attorney",
  label: "Escalate to attorney",
  pastLabel: "Escalated to attorney",
  variant: "secondary",
  kind: "mutation",
  scenarios: ["lead"],
});

const ASSIGN_TO_ATTORNEY = A({
  key: "assign_to_attorney",
  label: "Assign to attorney",
  pastLabel: "Assigned to attorney",
  variant: "primary",
  kind: "mutation",
  scenarios: ["lead"],
});

const FLAG_FOR_ATTORNEY = A({
  key: "flag_for_attorney",
  label: "Flag for attorney",
  pastLabel: "Flagged for attorney",
  variant: "secondary",
  kind: "mutation",
  // Implemented for leads (creates a lead task); offered on cases too but not
  // yet wired, since there is no case task table.
  scenarios: ["lead", "case"],
  stubScenarios: ["case"],
});

const REQUEST_POSTPONEMENT = A({
  key: "request_postponement",
  label: "Request postponement",
  pastLabel: "Postponement requested",
  variant: "secondary",
  kind: "mutation",
  scenarios: ["lead"],
});

const SET_CALENDAR_ALERT = A({
  key: "set_calendar_alert",
  label: "Set calendar alert",
  pastLabel: "Calendar alert set",
  variant: "secondary",
  kind: "mutation",
  scenarios: ["case"],
});

// Offered but a stub everywhere: the documents schema has no filed state
// (status is active / archived / deleted), so there is nothing to write yet.
// Ships visible per product decision; dispatch refuses it until a filing field
// exists.
const MARK_AS_FILED = A({
  key: "mark_as_filed",
  label: "Mark as filed",
  pastLabel: "Marked as filed",
  variant: "primary",
  kind: "mutation",
  scenarios: BOTH,
  stubScenarios: BOTH,
});

const VIEW_CASE = A({
  key: "view_case",
  label: "View case",
  pastLabel: "Case opened",
  variant: "secondary",
  kind: "navigate",
  scenarios: BOTH,
  target: "case",
});

const VIEW_DOCUMENT = A({
  key: "view_document",
  label: "View document",
  pastLabel: "Document opened",
  variant: "secondary",
  kind: "navigate",
  scenarios: BOTH,
  target: "document",
});

export const ALL_ACTIONS: ActionDef[] = [
  REQUEST_REUPLOAD,
  SEND_CLIENT_REMINDER,
  SEND_URGENT_REMINDER,
  ESCALATE_TO_ATTORNEY,
  ASSIGN_TO_ATTORNEY,
  FLAG_FOR_ATTORNEY,
  REQUEST_POSTPONEMENT,
  SET_CALENDAR_ALERT,
  MARK_AS_FILED,
  VIEW_CASE,
  VIEW_DOCUMENT,
];

const BY_KEY = new Map(ALL_ACTIONS.map((a) => [a.key, a]));

// ── Which actions each rule offers ───────────────────────────────────────────

/**
 * Ordered as the dashboard renders them: the primary action first, then
 * secondaries, then navigation. Mirrors the agreed mockups.
 */
const REGISTRY: Record<string, ActionDef[]> = {
  missing_required_document: [
    SEND_CLIENT_REMINDER,
    ESCALATE_TO_ATTORNEY,
    VIEW_CASE,
  ],
  document_expiry_before_deadline: [
    REQUEST_REUPLOAD,
    REQUEST_POSTPONEMENT,
    FLAG_FOR_ATTORNEY,
    VIEW_CASE,
  ],
  deadline_approaching_incomplete: [
    ASSIGN_TO_ATTORNEY,
    SET_CALENDAR_ALERT,
    VIEW_CASE,
  ],
  filing_not_marked_submitted: [MARK_AS_FILED, VIEW_DOCUMENT, VIEW_CASE],
  field_conflict_across_documents: [
    REQUEST_REUPLOAD,
    FLAG_FOR_ATTORNEY,
    VIEW_CASE,
  ],
  field_conflict_with_scenario_record: [FLAG_FOR_ATTORNEY, VIEW_CASE],
  photo_mismatch: [FLAG_FOR_ATTORNEY, VIEW_DOCUMENT, VIEW_CASE],
  document_authenticity_suspect: [
    FLAG_FOR_ATTORNEY,
    REQUEST_REUPLOAD,
    VIEW_CASE,
  ],
};

/**
 * Actions for an issue on a matter of `scenarioType`.
 *
 * Filtered to actions whose effect can actually run against that matter type —
 * a lead issue is not offered "Set calendar alert" (calendar events are
 * case-scoped) and a case issue is not offered the attorney-task actions (tasks
 * are lead-scoped). An unrecognised issue type still gets "View case" so a rule
 * added ahead of its registry entry is never a dead end.
 */
export const actionsFor = (
  issueType: string,
  scenarioType: ScenarioType,
): ActionDef[] =>
  (REGISTRY[issueType] ?? [VIEW_CASE]).filter((a) =>
    a.scenarios.includes(scenarioType),
  );

export const isActionAllowed = (
  issueType: string,
  scenarioType: ScenarioType,
  key: string,
): boolean => actionsFor(issueType, scenarioType).some((a) => a.key === key);

/** True when this action is offered on the scenario but not yet implemented. */
export const isStubAction = (
  action: ActionDef,
  scenarioType: ScenarioType,
): boolean => action.stubScenarios?.includes(scenarioType) ?? false;

export const findAction = (key: string): ActionDef | undefined => BY_KEY.get(key);

/**
 * The action shape sent to the client — button essentials plus a `stub` flag so
 * the UI can render an unbuilt action as "not yet available". Deliberately omits
 * `pastLabel`, `scenarios` and `stubScenarios`, which are server-side concerns.
 */
export type PresentedAction = {
  key: string;
  label: string;
  variant: ActionVariant;
  kind: ActionKind;
  target?: "case" | "document";
  stub: boolean;
};

export const presentActions = (
  issueType: string,
  scenarioType: ScenarioType,
): PresentedAction[] =>
  actionsFor(issueType, scenarioType).map((a) => ({
    key: a.key,
    label: a.label,
    variant: a.variant,
    kind: a.kind,
    target: a.target,
    stub: isStubAction(a, scenarioType),
  }));

/**
 * Label for the resolution log's "Action taken" pill.
 *
 * `language` is accepted now so callers are stable when locale packs arrive,
 * matching `renderIssue`'s signature; only English exists today.
 */
export const actionLabel = (key: string, _language: string): string =>
  BY_KEY.get(key)?.pastLabel ?? key.replace(/_/g, " ");
