import { BadRequestError } from "../../utils/error/app-error";
import { toMoney } from "./money";

/**
 * The arithmetic of payment schedules: generating one, and working out how far
 * a payment gets down it.
 *
 * Pure — no database, no request context — so it can be unit-tested directly and
 * imported from anywhere without a cycle. The write path lives in
 * instalments.service.ts.
 *
 * The allocation rule is oldest-first and DERIVED. `invoices.amount_paid` is the
 * only stored paid figure; walking the schedule in due-date order says how much
 * of each instalment that covers. `allocate()` here and the window function in
 * dues.ts are the same arithmetic in two languages — change one and you must
 * change the other, or the API and the aging report will disagree about the
 * same schedule.
 */

export type InstalmentFrequency = "weekly" | "fortnightly" | "monthly";

export type ScheduleRow = { dueDate: string; amount: number };

/** A YYYY-MM-DD offset that never constructs a local Date, so no timezone shifts it. */
const addDays = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
};

/**
 * Add whole months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. Rolling over would put
 * an instalment in the wrong month and, worse, out of order against its
 * neighbours — which the schedule's renumbering would then silently accept.
 */
const addMonths = (ymd: string, months: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(d!, lastDay),
    ),
  )
    .toISOString()
    .slice(0, 10);
};

const advance = (
  start: string,
  step: number,
  frequency: InstalmentFrequency,
): string => {
  if (frequency === "weekly") return addDays(start, step * 7);
  if (frequency === "fortnightly") return addDays(start, step * 14);
  return addMonths(start, step);
};

/**
 * Cut `total` into `count` dated instalments.
 *
 * The remainder goes on the FINAL instalment so the rows sum to `total`
 * exactly — placed rather than lost. Dividing without placing it gives
 * `1000 / 3 = 333.33 x 3 = 999.99`, which fails `assertScheduleBalances` every
 * time; the fee-agreement wizard has exactly that bug today.
 */
export const generateSchedule = (
  total: number,
  count: number,
  startDate: string,
  frequency: InstalmentFrequency,
): ScheduleRow[] => {
  if (!Number.isInteger(count) || count < 1) {
    throw new BadRequestError("A schedule needs at least one instalment");
  }
  const target = toMoney(total);
  if (target <= 0) {
    throw new BadRequestError("An invoice with no balance cannot be scheduled");
  }

  const each = toMoney(target / count);
  const rows: ScheduleRow[] = [];
  let allocated = 0;

  for (let i = 0; i < count; i += 1) {
    const amount = i === count - 1 ? toMoney(target - allocated) : each;
    allocated = toMoney(allocated + amount);
    rows.push({ dueDate: advance(startDate, i, frequency), amount });
  }

  // Reachable when the count is high enough that the equal share rounds to zero
  // and the whole total lands on the last row.
  if (rows.some((r) => r.amount <= 0)) {
    throw new BadRequestError(
      "That many instalments would leave one at zero — reduce the count",
    );
  }

  return rows;
};

export type Allocatable = { dueDate: string; sequence: number; amount: number };

export type AllocatedInstalment<T extends Allocatable> = T & {
  amountPaid: number;
  outstanding: number;
  /**
   * Payment state only. Whether an unpaid instalment is *overdue* depends on the
   * firm's today, which this module deliberately does not know.
   */
  state: "paid" | "partial" | "due";
};

/**
 * Apply `amountPaid` down the schedule, oldest first.
 *
 * The TypeScript twin of `outstandingPerInstalment` in dues.ts. Both exist
 * because the API and the PDF need per-instalment state on a schedule they have
 * already loaded, while the aggregates need it in SQL across thousands of rows.
 */
export const allocate = <T extends Allocatable>(
  instalments: T[],
  amountPaid: number,
): AllocatedInstalment<T>[] => {
  const ordered = [...instalments].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.sequence - b.sequence,
  );

  let remaining = toMoney(amountPaid);

  return ordered.map((row) => {
    const paid = Math.min(Math.max(remaining, 0), row.amount);
    remaining = toMoney(remaining - paid);
    const outstanding = toMoney(row.amount - paid);
    return {
      ...row,
      amountPaid: toMoney(paid),
      outstanding,
      state: outstanding <= 0 ? "paid" : paid > 0 ? "partial" : "due",
    };
  });
};

/** The date the invoice is next owed money on, or null when nothing is left. */
export const nextDueDateFrom = (
  instalments: Allocatable[],
  amountPaid: number,
): string | null =>
  allocate(instalments, amountPaid).find((i) => i.outstanding > 0)?.dueDate ??
  null;
