import type { Severity } from "./types";

const ORDER: Severity[] = ["low", "medium", "high", "critical"];
const rank = (s: Severity) => ORDER.indexOf(s);

/** Cap a severity at `max` — e.g. image judgments are never above `medium`. */
export const capSeverity = (severity: Severity, max: Severity): Severity =>
  rank(severity) > rank(max) ? max : severity;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `now` to `target` (negative = overdue). */
export const daysUntil = (target: Date, now: Date): number =>
  Math.ceil((target.getTime() - now.getTime()) / DAY_MS);

/**
 * Severity as a deadline approaches. Overdue or ≤3 days is critical; the window
 * widens down through high/medium to low. Shared by the deadline-driven rules so
 * urgency is computed one way.
 */
export const deadlineSeverity = (daysToDeadline: number): Severity => {
  if (daysToDeadline <= 3) return "critical"; // includes overdue (negative)
  if (daysToDeadline <= 7) return "high";
  if (daysToDeadline <= 30) return "medium";
  return "low";
};
