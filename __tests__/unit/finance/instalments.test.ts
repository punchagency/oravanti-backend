import {
  allocate,
  generateSchedule,
  nextDueDateFrom,
} from "../../../src/modules/finance/instalments";

/**
 * The schedule arithmetic. Everything here is pure, so these run without a
 * database.
 *
 * `allocate` is one of two implementations of the same rule — the other is the
 * window function in dues.ts. If you change either, change both, or the invoice
 * detail and the aging report will describe the same schedule differently.
 */

describe("generateSchedule", () => {
  it("sums to the total exactly when the division is not clean", () => {
    const rows = generateSchedule(1000, 3, "2026-09-01", "monthly");
    expect(rows.map((r) => r.amount)).toEqual([333.33, 333.33, 333.34]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(1000);
  });

  it("places the remainder rather than dropping it", () => {
    // 333.33 x 3 = 999.99. Losing the cent fails the balance check on every
    // save — the bug the fee-agreement wizard has today.
    for (const total of [1000, 100.01, 0.03, 9999.99]) {
      const rows = generateSchedule(total, 3, "2026-01-01", "monthly");
      expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(total, 2);
    }
  });

  it("steps monthly, clamping to the end of the month", () => {
    // 31 Jan + 1 month is 28 Feb. Rolling into 3 March would put the instalment
    // in the wrong month and out of order against its neighbours.
    expect(
      generateSchedule(300, 3, "2026-01-31", "monthly").map((r) => r.dueDate),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("handles a leap year", () => {
    expect(
      generateSchedule(200, 2, "2028-01-29", "monthly")[1]!.dueDate,
    ).toBe("2028-02-29");
  });

  it("steps weekly and fortnightly", () => {
    expect(
      generateSchedule(300, 3, "2026-09-01", "weekly").map((r) => r.dueDate),
    ).toEqual(["2026-09-01", "2026-09-08", "2026-09-15"]);
    expect(
      generateSchedule(200, 2, "2026-09-01", "fortnightly")[1]!.dueDate,
    ).toBe("2026-09-15");
  });

  it("supports a single instalment", () => {
    const rows = generateSchedule(500, 1, "2026-09-01", "monthly");
    expect(rows).toEqual([{ dueDate: "2026-09-01", amount: 500 }]);
  });

  it("refuses a count or total that cannot produce a schedule", () => {
    expect(() => generateSchedule(1000, 0, "2026-09-01", "monthly")).toThrow();
    expect(() => generateSchedule(1000, 1.5, "2026-09-01", "monthly")).toThrow();
    expect(() => generateSchedule(0, 3, "2026-09-01", "monthly")).toThrow();
    // The equal share rounds to zero, so a row would be non-positive.
    expect(() => generateSchedule(0.01, 5, "2026-09-01", "monthly")).toThrow();
  });
});

describe("allocate", () => {
  const rows = [
    { sequence: 1, dueDate: "2026-09-01", amount: 500 },
    { sequence: 2, dueDate: "2026-10-01", amount: 500 },
    { sequence: 3, dueDate: "2026-11-01", amount: 500 },
  ];

  it("settles the oldest instalment first", () => {
    expect(allocate(rows, 500).map((a) => a.state)).toEqual([
      "paid",
      "due",
      "due",
    ]);
  });

  it("splits a payment that spans two instalments", () => {
    const [, second] = allocate(rows, 700);
    expect(second!.amountPaid).toBe(200);
    expect(second!.outstanding).toBe(300);
    expect(second!.state).toBe("partial");
  });

  it("never reports a negative outstanding on an overpayment", () => {
    const result = allocate(rows, 5000);
    expect(result.every((a) => a.outstanding === 0)).toBe(true);
    expect(result.every((a) => a.state === "paid")).toBe(true);
  });

  it("leaves everything owing when nothing is paid", () => {
    expect(allocate(rows, 0).map((a) => a.outstanding)).toEqual([500, 500, 500]);
  });

  it("orders by due date, not by input order", () => {
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(allocate(shuffled, 500).map((a) => a.dueDate)).toEqual([
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
    ]);
  });

  it("breaks a same-date tie on sequence and walks them one at a time", () => {
    const sameDay = [
      { sequence: 1, dueDate: "2026-09-01", amount: 500 },
      { sequence: 2, dueDate: "2026-09-01", amount: 500 },
    ];
    // Not 500 outstanding on both, which is what a peer-grouped running total
    // would produce.
    expect(allocate(sameDay, 500).map((a) => a.outstanding)).toEqual([0, 500]);
  });
});

describe("nextDueDateFrom", () => {
  const rows = [
    { sequence: 1, dueDate: "2026-09-01", amount: 500 },
    { sequence: 2, dueDate: "2026-10-01", amount: 500 },
  ];

  it("is the first instalment the payments have not reached", () => {
    expect(nextDueDateFrom(rows, 0)).toBe("2026-09-01");
    expect(nextDueDateFrom(rows, 500)).toBe("2026-10-01");
    // A part-paid instalment is still the next one owed.
    expect(nextDueDateFrom(rows, 600)).toBe("2026-10-01");
  });

  it("is null once everything is covered", () => {
    expect(nextDueDateFrom(rows, 1000)).toBeNull();
    expect(nextDueDateFrom(rows, 1500)).toBeNull();
  });

  it("is null when there is no schedule", () => {
    expect(nextDueDateFrom([], 0)).toBeNull();
  });
});
