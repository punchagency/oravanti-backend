/**
 * Questionnaire branching — which questions a given set of answers puts on
 * screen, and which of them are required once they are there.
 *
 * ─── This file is mirrored, and the two copies must stay byte-identical ─────
 *
 * `oravanti-be/src/lib/questionnaire/logic.ts` and
 * `oravanti-fe/src/lib/questionnaire/logic.ts` are the same file, copied. It is
 * import-free on both sides so it can be copied across verbatim; when one side
 * changes, copy the whole file rather than hand-patching one branch. The audit
 * action registry is kept the same way and for the same reason.
 *
 * It is mirrored because both sides genuinely have to evaluate it:
 *
 * - The **client** needs branching to happen as they type. Answering "No" to
 *   "have you been married before" must hide the ex-spouse questions in the
 *   same instant, not after a round trip.
 * - The **server** must never demand an answer to a question the client was not
 *   shown, and must never carry one onto a form. A hidden question that is
 *   still required blocks submission with an error pointing at something
 *   invisible; a stale answer inside a collapsed branch prints an ex-spouse on
 *   a filing after the client said there was not one.
 *
 * Evaluating on one side only breaks one of those. Evaluating on both, from two
 * implementations, breaks them intermittently and much later, which is worse.
 *
 * ─── The default is visible ─────────────────────────────────────────────────
 *
 * A question with no rule pointing at it is shown, and is required exactly as
 * its own `isRequired` says. Rules change that:
 *
 * - a `show_question` rule makes its target conditional — hidden *unless* the
 *   condition holds. This is the ordinary way to write a branch.
 * - a `hide_question` rule hides its target *when* the condition holds.
 * - a `require_question` rule adds required-ness when the condition holds. It
 *   never removes it: a question required on its own row stays required.
 *
 * When several rules point at one target, **hiding wins**. A question two rules
 * disagree about is one somebody has mis-wired, and the safe reading of "one of
 * these says this should not be here" is not to ask it.
 *
 * ─── What this deliberately does not do ─────────────────────────────────────
 *
 * `skip_to_question`, `skip_to_section`, `branch_to_section` and
 * `end_questionnaire` are in the action enum and are **not evaluated here**.
 * They describe a wizard that walks one question at a time; the portal renders
 * every section on one page, where "skip to" has no meaning distinct from
 * "hide the ones in between". They are ignored rather than approximated —
 * guessing at one would silently drop questions from a filing.
 */

/** How a rule tests the answer to its source question. */
export type LogicCondition =
  | { operator: "equals"; value: unknown }
  | { operator: "not_equals"; value: unknown }
  | { operator: "in"; values: unknown[] }
  | { operator: "answered" }
  | { operator: "blank" };

/** One rule, as the row stores it. */
export type LogicRule = {
  id: string;
  sourceQuestionId: string;
  targetQuestionId: string | null;
  targetSectionId: string | null;
  condition: unknown;
  actionType: string;
  priority: number;
};

/** What the rules make of one set of answers. */
export type LogicResult = {
  /** Question ids that must not be shown, saved, or required. */
  hiddenQuestionIds: Set<string>;
  /** Section ids that must not be shown. Their questions are hidden with them. */
  hiddenSectionIds: Set<string>;
  /** Question ids a rule has made required on top of their own flag. */
  requiredQuestionIds: Set<string>;
};

/**
 * An answer reduced to something comparable.
 *
 * Answers are `jsonb`: a yes/no is a boolean, a choice is a string, a
 * multi-select and a repeating answer are arrays. A rule's value is written by
 * hand in a seed. The two meet here, and the rules are deliberately few:
 *
 * - case and surrounding whitespace never matter;
 * - the several spellings of yes and no are one thing, because a rule written
 *   as "yes" must match a `yes_no` question storing `true`;
 * - everything else compares as its own text.
 *
 * No number coercion: "01" and 1 are different answers on a form, and a
 * questionnaire that decided otherwise would be guessing.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";

  const text = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "true" || text === "y") return "yes";
  if (text === "false" || text === "n") return "no";
  return text;
}

/** Whether an answer counts as given. An empty list is not an answer. */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Read a stored condition as one this build understands.
 *
 * Returns null for anything else, and a rule with a null condition is ignored —
 * never applied, never thrown on. The column is `jsonb` with no schema behind
 * it, and a newer deployment can write an operator this build has never seen; a
 * questionnaire that fails to render is worse than one showing a question it
 * could have hidden.
 */
export function parseCondition(raw: unknown): LogicCondition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as {
    operator?: unknown;
    value?: unknown;
    values?: unknown;
  };

  switch (candidate.operator) {
    case "equals":
      return { operator: "equals", value: candidate.value };
    case "not_equals":
      return { operator: "not_equals", value: candidate.value };
    case "in":
      return Array.isArray(candidate.values)
        ? { operator: "in", values: candidate.values }
        : null;
    case "answered":
      return { operator: "answered" };
    case "blank":
      return { operator: "blank" };
    default:
      return null;
  }
}

/** Whether one condition holds for one answer. */
export function conditionHolds(
  condition: LogicCondition,
  answer: unknown,
): boolean {
  switch (condition.operator) {
    case "answered":
      return isAnswered(answer);
    case "blank":
      return !isAnswered(answer);
    case "equals":
      return matches(answer, condition.value);
    case "not_equals":
      return !matches(answer, condition.value);
    case "in":
      return condition.values.some((value) => matches(answer, value));
  }
}

/**
 * Whether an answer matches a rule's value.
 *
 * A multi-select answers with a list, and a rule asking `equals: "Cuba"` about
 * one means "is Cuba among them" — the other reading, that the client chose
 * Cuba and nothing else, is not what anybody writing a rule intends.
 */
function matches(answer: unknown, value: unknown): boolean {
  const wanted = canonical(value);
  if (Array.isArray(answer)) {
    return answer.some((entry) => canonical(entry) === wanted);
  }
  return canonical(answer) === wanted;
}

/**
 * Apply every rule to one set of answers.
 *
 * @param rules Every rule on the questionnaire.
 * @param answers The answers so far, keyed by question id. A question with no
 *   entry is unanswered, which is not the same as answered with nothing.
 */
export function evaluateLogic(
  rules: LogicRule[],
  answers: Map<string, unknown>,
): LogicResult {
  const hiddenQuestionIds = new Set<string>();
  const hiddenSectionIds = new Set<string>();
  const requiredQuestionIds = new Set<string>();

  /*
    A `show_question` rule makes its target conditional, so the target starts
    hidden and a holding condition reveals it. Collected rather than applied in
    place, because a target with two show rules is revealed by either — an "or",
    which is what somebody writing two rules for one question means.
  */
  const conditional = new Map<string, boolean>();
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    const condition = parseCondition(rule.condition);
    if (!condition) continue;

    const target = rule.targetQuestionId ?? rule.targetSectionId;
    if (!target) continue;

    const holds = conditionHolds(condition, answers.get(rule.sourceQuestionId));

    switch (rule.actionType) {
      case "show_question":
        conditional.set(target, (conditional.get(target) ?? false) || holds);
        break;

      case "hide_question":
        if (holds) hide(rule, hiddenQuestionIds, hiddenSectionIds);
        break;

      case "require_question":
        if (holds && rule.targetQuestionId) {
          requiredQuestionIds.add(rule.targetQuestionId);
        }
        break;

      default:
        // A wizard-flow action, or one a newer deployment added. See the note
        // at the top of this file: ignored, never approximated.
        break;
    }
  }

  for (const [target, revealed] of conditional) {
    if (revealed) continue;
    const rule = ordered.find(
      (candidate) =>
        (candidate.targetQuestionId ?? candidate.targetSectionId) === target,
    );
    if (rule) hide(rule, hiddenQuestionIds, hiddenSectionIds);
  }

  // Hiding wins over requiring: a question nobody is shown cannot be one they
  // are stopped from submitting without.
  for (const id of hiddenQuestionIds) requiredQuestionIds.delete(id);

  return { hiddenQuestionIds, hiddenSectionIds, requiredQuestionIds };
}

function hide(
  rule: LogicRule,
  questions: Set<string>,
  sections: Set<string>,
): void {
  if (rule.targetQuestionId) questions.add(rule.targetQuestionId);
  else if (rule.targetSectionId) sections.add(rule.targetSectionId);
}

/**
 * Every question the rules put out of sight, sections included.
 *
 * The one function a caller outside the portal should need. Submission
 * validation, the population pass and the save all ask the same thing — "is
 * this a question the client was shown?" — and all three must get the same
 * answer, or a filing carries something the client withdrew.
 */
export function hiddenQuestions(
  rules: LogicRule[],
  answers: Map<string, unknown>,
  sectionOfQuestion: Map<string, string>,
): Set<string> {
  const result = evaluateLogic(rules, answers);
  const hidden = new Set(result.hiddenQuestionIds);

  for (const [questionId, sectionId] of sectionOfQuestion) {
    if (result.hiddenSectionIds.has(sectionId)) hidden.add(questionId);
  }

  return hidden;
}
