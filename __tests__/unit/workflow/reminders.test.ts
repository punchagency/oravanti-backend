import { describe, expect, it } from "@jest/globals";
import {
  pendingThreshold,
  rfeReminderSchedule,
  type ReminderSentColumns,
} from "../../../src/modules/workflow/reminder.service";
import { delayRatio } from "../../../src/modules/workflow/mandamus.service";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("rfeReminderSchedule", () => {
  const dates = (issued: string, deadline: string) =>
    rfeReminderSchedule(d(issued), d(deadline)).map((r) => r.dueDate);

  // The three windows USCIS actually issues — read from the notice, never
  // hardcoded, which is the whole reason this is a hook and not a template step.
  it("places reminders at 50/75/90% of a 30-day window", () => {
    expect(dates("2026-03-01", "2026-03-31")).toEqual(["2026-03-16", "2026-03-24", "2026-03-28"]);
  });

  it("places reminders at 50/75/90% of a 60-day window", () => {
    expect(dates("2026-03-01", "2026-04-30")).toEqual(["2026-03-31", "2026-04-15", "2026-04-24"]);
  });

  it("places reminders at 50/75/90% of an 87-day window", () => {
    // 87 × .5/.75/.9 = 43.5 / 65.25 / 78.3, rounded to 44 / 65 / 78 days.
    expect(dates("2026-03-01", "2026-05-27")).toEqual(["2026-04-14", "2026-05-05", "2026-05-18"]);
  });

  it("always lands every reminder before the deadline", () => {
    for (const window of [30, 60, 87]) {
      const issued = d("2026-03-01");
      const deadline = new Date(issued);
      deadline.setUTCDate(deadline.getUTCDate() + window);
      for (const r of rfeReminderSchedule(issued, deadline)) {
        expect(new Date(`${r.dueDate}T00:00:00.000Z`).getTime()).toBeLessThan(deadline.getTime());
      }
    }
  });

  it("labels each reminder with its percentage", () => {
    expect(rfeReminderSchedule(d("2026-03-01"), d("2026-03-31")).map((r) => r.title)).toEqual([
      "RFE response reminder (50% of window elapsed)",
      "RFE response reminder (75% of window elapsed)",
      "RFE response reminder (90% of window elapsed)",
    ]);
  });

  it("returns nothing for a non-positive window rather than inventing reminders", () => {
    expect(rfeReminderSchedule(d("2026-03-31"), d("2026-03-01"))).toEqual([]);
    expect(rfeReminderSchedule(d("2026-03-01"), d("2026-03-01"))).toEqual([]);
  });
});

describe("pendingThreshold", () => {
  const TODAY = d("2026-03-10");
  const task = (o: Partial<ReminderSentColumns> = {}): ReminderSentColumns => ({
    dueDate: null,
    reminder3dSentAt: null,
    reminder1dSentAt: null,
    overdueReminderSentAt: null,
    ...o,
  });

  it("ignores a task with no due date", () => {
    expect(pendingThreshold(task(), TODAY)).toBeNull();
  });

  it("ignores a task due beyond the 3-day horizon", () => {
    expect(pendingThreshold(task({ dueDate: "2026-03-20" }), TODAY)).toBeNull();
  });

  it("reports the 3-day threshold", () => {
    expect(pendingThreshold(task({ dueDate: "2026-03-13" }), TODAY)).toMatchObject({
      column: "reminder3dSentAt",
      category: "task_due_soon",
    });
  });

  it("reports the 1-day threshold", () => {
    expect(pendingThreshold(task({ dueDate: "2026-03-11" }), TODAY)).toMatchObject({
      column: "reminder1dSentAt",
      category: "task_due_soon",
    });
  });

  it("reports overdue on the due date itself and after it", () => {
    for (const dueDate of ["2026-03-10", "2026-03-01"]) {
      expect(pendingThreshold(task({ dueDate }), TODAY)).toMatchObject({
        column: "overdueReminderSentAt",
        category: "task_overdue",
      });
    }
  });

  it("prefers overdue over due-soon for a past-due task", () => {
    // Most-urgent-first: a task 9 days overdue must not report "due in 3 days".
    expect(pendingThreshold(task({ dueDate: "2026-03-01" }), TODAY)).toMatchObject({ category: "task_overdue" });
  });

  describe("de-duplication", () => {
    it("fires each threshold exactly once across repeated sweeps", () => {
      // Walk one task through the whole cascade, stamping the column the sweep
      // would stamp, and assert nothing ever fires twice.
      const state = task({ dueDate: "2026-03-13" });
      const fired: string[] = [];

      for (const today of ["2026-03-10", "2026-03-10", "2026-03-12", "2026-03-12", "2026-03-13", "2026-03-14"]) {
        const threshold = pendingThreshold(state, d(today));
        if (!threshold) continue;
        fired.push(threshold.column);
        state[threshold.column] = new Date();
      }

      expect(fired).toEqual(["reminder3dSentAt", "reminder1dSentAt", "overdueReminderSentAt"]);
    });

    it("stays silent once the crossed threshold has already been sent", () => {
      expect(pendingThreshold(task({ dueDate: "2026-03-13", reminder3dSentAt: new Date() }), TODAY)).toBeNull();
      expect(pendingThreshold(task({ dueDate: "2026-03-01", overdueReminderSentAt: new Date() }), TODAY)).toBeNull();
    });

    it("still reports overdue for a task that only got its due-soon reminder", () => {
      expect(
        pendingThreshold(task({ dueDate: "2026-03-09", reminder3dSentAt: new Date(), reminder1dSentAt: new Date() }), TODAY),
      ).toMatchObject({ category: "task_overdue" });
    });
  });
});

describe("delayRatio", () => {
  it("divides days pending by the published median", () => {
    expect(delayRatio(600, 300)).toBe(2);
    expect(delayRatio(450, 300)).toBe(1.5);
  });

  it("rounds to two decimal places", () => {
    expect(delayRatio(100, 3)).toBe(33.33);
  });

  it("reports under-median cases as a ratio below 1, not as null", () => {
    expect(delayRatio(150, 300)).toBe(0.5);
  });

  it("returns null when no median is on file — unknown, not 'not delayed'", () => {
    expect(delayRatio(600, null)).toBeNull();
  });

  it("returns null rather than dividing by zero", () => {
    expect(delayRatio(600, 0)).toBeNull();
  });
});
