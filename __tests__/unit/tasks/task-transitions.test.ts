import { describe, expect, it } from "@jest/globals";
import {
  transitionViolation,
  type TaskTransition,
} from "../../../src/modules/tasks/task-transitions.service";

/*
  This state machine used to exist twice — once for intake tasks and once for
  case workflow steps — and the two copies had already drifted in their error
  messages. Now there is one, which means one thing to pin down and one place a
  regression can hide.

  The failure modes are all quiet: a verb that accepts a status it shouldn't
  moves a task backwards through review, and a reject with no feedback leaves an
  assignee looking at a rejected task with nothing to act on.
*/

const ALL_STATUSES = [
  "pending",
  "in_progress",
  "in_review",
  "completed",
  "skipped",
  "rejected",
  "cancelled",
] as const;

const allows = (transition: TaskTransition, status: string, note = "a note") =>
  transitionViolation({ status }, transition, note) === null;

describe("which statuses each verb accepts", () => {
  it.each([
    ["start", ["pending"]],
    ["submit", ["in_progress", "rejected"]],
    ["approve", ["in_review"]],
    ["reject", ["in_review"]],
    ["reopen", ["rejected", "completed", "skipped"]],
  ] as const)("%s accepts exactly %j", (transition, expected) => {
    const accepted = ALL_STATUSES.filter((s) => allows(transition, s));

    expect([...accepted].sort()).toEqual([...expected].sort());
  });

  it("lets complete run from any status", () => {
    // Deliberately unguarded: marking something done is how a person corrects a
    // task that went the wrong way, and the timeline records where it came from.
    const refused = ALL_STATUSES.filter((s) => !allows("complete", s));

    expect(refused).toEqual([]);
  });

  it("lets a rejected task be resubmitted without a reopen round trip", () => {
    // The one non-obvious edge in the machine, and the reason `submit` takes two
    // statuses instead of one.
    expect(allows("submit", "rejected")).toBe(true);
  });

  it("lets a closed step be brought back", () => {
    // Work gets marked done in error, or skipped and then turns out to matter.
    // Without this the firm's only options are a wrong record or a duplicate
    // task beside it.
    expect(allows("reopen", "completed")).toBe(true);
    expect(allows("reopen", "skipped")).toBe(true);
  });
});

describe("starting a task is the assignee's own act", () => {
  /*
    Before this verb existed there was no way into `in_progress` except
    materialization stamping it at auto-assignment, which meant every step on a
    freshly opened matter claimed to be underway. Assignment now leaves the task
    `pending`; this is the only thing that advances it.
  */
  it("cannot start a task that is already going", () => {
    expect(allows("start", "in_progress")).toBe(false);
  });

  it("cannot start a task that is finished, withdrawn or in review", () => {
    for (const status of ["in_review", "completed", "skipped", "rejected", "cancelled"]) {
      expect(allows("start", status)).toBe(false);
    }
  });

  it("does not require a note", () => {
    expect(transitionViolation({ status: "pending" }, "start", undefined)).toBeNull();
  });

  it("keeps submit strict, so starting is a real step and not a formality", () => {
    // `complete` is deliberately unguarded, but submit is not: if a pending task
    // could be submitted straight for review, Start would be decorative and the
    // status would go back to meaning nothing.
    expect(allows("submit", "pending")).toBe(false);
  });
});

describe("feedback on rejection", () => {
  it("refuses a rejection with nothing to act on", () => {
    for (const note of [undefined, "", "   "]) {
      expect(transitionViolation({ status: "in_review" }, "reject", note)).toMatch(
        /feedback/i,
      );
    }
  });

  it("does not require a note on any other verb", () => {
    const requiring = (["complete", "submit", "approve", "reopen"] as const).filter(
      (t) => !allows(t, t === "reopen" ? "rejected" : t === "approve" ? "in_review" : "in_progress", undefined),
    );

    expect(requiring).toEqual([]);
  });
});

describe("refusal messages", () => {
  it("says what the task's status actually allows", () => {
    // The message is what a user sees when a button they could press turns out
    // not to apply — "Bad request" would tell them nothing.
    expect(transitionViolation({ status: "pending" }, "approve", undefined)).toBe(
      "Only tasks in review can be approved",
    );
    expect(transitionViolation({ status: "pending" }, "reopen", undefined)).toBe(
      "Only rejected, completed or skipped tasks can be reopened",
    );
  });
});
