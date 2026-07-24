import { ALL_RULES } from "./rules";
import type { CandidateIssue, Rule, RuleContext } from "./types";

/**
 * Run every enabled rule against the context and collect candidate issues.
 *
 * Per-rule isolation: one rule throwing must not sink the others (a bad AI
 * payload shouldn't suppress a deterministic missing-document flag). Failures
 * are logged, not swallowed silently.
 */
export const runRules = (
  ctx: RuleContext,
  rules: Rule[] = ALL_RULES,
): CandidateIssue[] => {
  const candidates: CandidateIssue[] = [];
  for (const rule of rules) {
    if (rule.enabled && !rule.enabled(ctx)) continue;
    try {
      candidates.push(...rule.evaluate(ctx));
    } catch (err) {
      console.error(`[case-review] rule ${rule.issueType} failed:`, err);
    }
  }
  return candidates;
};

export { ALL_RULES };
