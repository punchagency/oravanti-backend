import {
  canonical,
  conditionHolds,
  evaluateLogic,
  hiddenQuestions,
  parseCondition,
  type LogicRule,
} from "../../../src/lib/questionnaire/logic";

/**
 * Branching, asserted where it is silent when wrong.
 *
 * Every failure in this file is invisible in production: a question the client
 * cannot see blocking their submit button, or an answer they withdrew reaching
 * a signed federal form. There is no error either way.
 */

const rule = (over: Partial<LogicRule> = {}): LogicRule => ({
  id: "r1",
  sourceQuestionId: "src",
  targetQuestionId: "tgt",
  targetSectionId: null,
  condition: { operator: "equals", value: "yes" },
  actionType: "show_question",
  priority: 0,
  ...over,
});

describe("comparing an answer to a rule", () => {
  it("reads every spelling of yes as one thing", () => {
    // A rule is written by hand as "yes"; a yes_no question stores `true`.
    // These have to be the same answer or no branch on the questionnaire fires.
    for (const value of [true, "true", "Yes", " YES ", "y"]) {
      expect(canonical(value)).toBe("yes");
    }
    for (const value of [false, "false", "No", "n"]) {
      expect(canonical(value)).toBe("no");
    }
  });

  it("does not coerce numbers", () => {
    // "01" and 1 are different answers on a form. A questionnaire that decided
    // they were the same would be guessing on the client's behalf.
    expect(canonical("01")).toBe("01");
    expect(canonical(1)).toBe("1");
  });

  it("matches a multi-select if the value is among the choices", () => {
    const condition = parseCondition({ operator: "equals", value: "Cuba" })!;
    expect(conditionHolds(condition, ["Mexico", "Cuba"])).toBe(true);
    expect(conditionHolds(condition, ["Mexico"])).toBe(false);
  });

  it("treats an empty list as unanswered", () => {
    const answered = parseCondition({ operator: "answered" })!;
    expect(conditionHolds(answered, [])).toBe(false);
    expect(conditionHolds(answered, [{ street: "1 Main St" }])).toBe(true);
    expect(conditionHolds(answered, "  ")).toBe(false);
  });

  it("ignores an operator it does not know rather than throwing", () => {
    // A newer deployment can write one. A questionnaire that fails to render
    // is worse than one showing a question it could have hidden.
    expect(parseCondition({ operator: "matches_regex" })).toBeNull();
    expect(parseCondition({ operator: "in" })).toBeNull();
    expect(parseCondition("nonsense")).toBeNull();
    expect(parseCondition(null)).toBeNull();
  });
});

describe("what the rules make of a set of answers", () => {
  it("shows nothing by default and everything with no rules", () => {
    const result = evaluateLogic([], new Map());
    expect(result.hiddenQuestionIds.size).toBe(0);
  });

  it("hides a show-target until its condition holds", () => {
    const rules = [rule()];

    expect(evaluateLogic(rules, new Map()).hiddenQuestionIds.has("tgt")).toBe(
      true,
    );
    expect(
      evaluateLogic(rules, new Map([["src", false]])).hiddenQuestionIds.has(
        "tgt",
      ),
    ).toBe(true);
    expect(
      evaluateLogic(rules, new Map([["src", true]])).hiddenQuestionIds.has(
        "tgt",
      ),
    ).toBe(false);
  });

  it("reveals on either of two show rules", () => {
    // Somebody writing two rules for one question means "or". Requiring both
    // would make the second rule silently un-showable.
    const rules = [
      rule({ id: "a", sourceQuestionId: "s1" }),
      rule({ id: "b", sourceQuestionId: "s2" }),
    ];
    const result = evaluateLogic(rules, new Map([["s2", "yes"]]));
    expect(result.hiddenQuestionIds.has("tgt")).toBe(false);
  });

  it("lets hiding win over showing", () => {
    const rules = [
      rule({ id: "show", actionType: "show_question" }),
      rule({ id: "hide", actionType: "hide_question" }),
    ];
    const result = evaluateLogic(rules, new Map([["src", "yes"]]));
    expect(result.hiddenQuestionIds.has("tgt")).toBe(true);
  });

  it("never requires a question it has hidden", () => {
    /*
      The failure this prevents: a required question inside a collapsed branch
      makes the submit button fail with an error naming a field that is not on
      the screen, and the client has no way to act on it.
    */
    const rules = [
      rule({ id: "show" }),
      rule({ id: "req", actionType: "require_question" }),
    ];
    const result = evaluateLogic(rules, new Map([["src", "no"]]));
    expect(result.hiddenQuestionIds.has("tgt")).toBe(true);
    expect(result.requiredQuestionIds.has("tgt")).toBe(false);
  });

  it("requires a shown question when its condition holds", () => {
    const rules = [rule({ id: "req", actionType: "require_question" })];
    const result = evaluateLogic(rules, new Map([["src", "yes"]]));
    expect(result.requiredQuestionIds.has("tgt")).toBe(true);
  });

  it("ignores wizard-flow actions instead of approximating them", () => {
    // `skip_to_section` and friends describe a one-question-at-a-time walk the
    // portal does not do. Guessing would silently drop questions from a filing.
    const rules = [
      rule({ actionType: "skip_to_section", targetSectionId: "sec" }),
      rule({ actionType: "end_questionnaire" }),
    ];
    const result = evaluateLogic(rules, new Map([["src", "yes"]]));
    expect(result.hiddenQuestionIds.size).toBe(0);
    expect(result.hiddenSectionIds.size).toBe(0);
  });
});

describe("hiding a whole section", () => {
  it("takes its questions with it", () => {
    const rules = [rule({ targetQuestionId: null, targetSectionId: "sec-2" })];
    const sectionOf = new Map([
      ["q1", "sec-1"],
      ["q2", "sec-2"],
      ["q3", "sec-2"],
    ]);

    const hidden = hiddenQuestions(rules, new Map(), sectionOf);
    expect([...hidden].sort()).toEqual(["q2", "q3"]);
  });
});
