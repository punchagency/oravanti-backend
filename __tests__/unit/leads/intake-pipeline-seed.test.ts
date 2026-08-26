import { describe, expect, it } from "@jest/globals";
import { leadPipelineStageEnum } from "../../../src/db/schema/leads";
import { DEFAULT_INTAKE_PIPELINE_STEPS } from "../../../src/db/seeds/intake-pipeline.seed";

/*
  The intake checklist is a fixed list, not a template tree — so the things that
  can silently go wrong with it are different from the case workflow's, and
  narrower:

  - a role nobody holds means the step materializes unassigned, forever, with no
    error anywhere;
  - a gap or duplicate in a stage's `orderIndex` reorders the board, because the
    column is a per-stage ordinal that `saveIntakePipelineSteps` re-derives from
    list position;
  - a stage outside the enum fails at insert time, on a fresh database, during
    seeding.

  None of the three is caught by type-checking, and all three are caught here.
*/

const STAGES = new Set<string>(leadPipelineStageEnum.enumValues);

/** The baseline role pack. Intake is the one checklist where `receptionist` does real work. */
const REAL_ROLES = new Set(["attorney", "paralegal", "legal_assistant", "receptionist"]);

describe("the default intake checklist", () => {
  it("names a stage the enum knows", () => {
    const unknown = DEFAULT_INTAKE_PIPELINE_STEPS.filter(
      (s) => !STAGES.has(s.pipelineStage),
    ).map((s) => s.title);

    expect(unknown).toEqual([]);
  });

  it("numbers each stage's steps contiguously from 0", () => {
    const byStage = new Map<string, number[]>();
    for (const step of DEFAULT_INTAKE_PIPELINE_STEPS) {
      byStage.set(step.pipelineStage, [
        ...(byStage.get(step.pipelineStage) ?? []),
        step.orderIndex,
      ]);
    }

    const broken = [...byStage.entries()]
      .filter(([, indexes]) => indexes.some((n, i) => n !== i))
      .map(([stage, indexes]) => `${stage}: ${indexes.join(",")}`);

    expect(broken).toEqual([]);
  });

  it("gives every step at least one assignable role", () => {
    // An empty list is a legal value in the column — it means "leave it for
    // someone to claim" — but no step on the *default* checklist should want
    // that. A firm removing a role is a deliberate edit; shipping one blank is
    // an oversight, and looks identical on the board.
    const unassignable = DEFAULT_INTAKE_PIPELINE_STEPS.filter(
      (s) => !s.assignableRoles?.length,
    ).map((s) => s.title);

    expect(unassignable).toEqual([]);
  });

  it("names only roles that exist in the baseline role pack", () => {
    const unknown = new Set(
      DEFAULT_INTAKE_PIPELINE_STEPS.flatMap((s) => s.assignableRoles ?? []).filter(
        (r) => !REAL_ROLES.has(r),
      ),
    );

    expect([...unknown]).toEqual([]);
  });

  it("keeps the conflict check with an attorney", () => {
    // Clearing a conflict is a professional-responsibility call. If this ever
    // widens to include non-lawyers it should be a decision someone made, not a
    // line that drifted.
    const conflictCheck = DEFAULT_INTAKE_PIPELINE_STEPS.filter(
      (s) => s.pipelineStage === "conflict_check",
    );

    expect(conflictCheck).toHaveLength(1);
    expect(conflictCheck[0].assignableRoles).toEqual(["attorney"]);
  });

  it("declares no due dates", () => {
    // Deliberate: intake is short and its order carries the urgency, so a step
    // has a stage and a position and nothing else to be late against. The table
    // has no due-date column for these — this pins the decision, not the schema.
    const dated = DEFAULT_INTAKE_PIPELINE_STEPS.filter((s) => "dueDate" in s || "dueDateAnchor" in s);

    expect(dated).toEqual([]);
  });
});
