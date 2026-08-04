import { and, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { db } from "../../db/client";
import { teamMembers } from "../../db/schema";
import { certifications } from "../../db/schema/cases";
import { staff } from "../../db/schema/staff";
import { staffCertifications } from "../../db/schema/staff-certifications";
import { timeEntries } from "../../db/schema/time-entries";
import { dayjs } from "../../utils/date";
import { resolveAvatarUrl } from "../../utils/storage/avatar-url";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Period = "month" | "quarter" | "year" | "all";

// ─── Period Helpers ─────────────────────────────────────────────────────────
// Reporting periods are bucketed against the firm's local calendar, so all
// boundaries are computed in the firm timezone (`tz`) and emitted as
// "YYYY-MM-DD" strings.

const DATE_FMT = "YYYY-MM-DD";

function getPeriodRange(
  period: Period,
  tz: string,
): {
  startStr: string | null;
  endStr: string | null;
  label: string;
  months: number;
} {
  const now = dayjs().tz(tz);

  if (period === "month") {
    const start = now.startOf("month");
    const end = now.endOf("month");
    return {
      startStr: start.format(DATE_FMT),
      endStr: end.format(DATE_FMT),
      label: start.format("MMMM YYYY"),
      months: 1,
    };
  }

  if (period === "quarter") {
    const q = Math.floor(now.month() / 3);
    const start = now.month(q * 3).startOf("month");
    const end = now.month(q * 3 + 2).endOf("month");
    return {
      startStr: start.format(DATE_FMT),
      endStr: end.format(DATE_FMT),
      label: `Q${q + 1} ${now.year()} (${start.format("MMM")} - ${end.format("MMM")})`,
      months: 3,
    };
  }

  if (period === "year") {
    const start = now.startOf("year");
    const end = now.endOf("year");
    return {
      startStr: start.format(DATE_FMT),
      endStr: end.format(DATE_FMT),
      label: String(now.year()),
      months: 12,
    };
  }

  return { startStr: null, endStr: null, label: "All Time", months: 0 };
}

function getPreviousPeriodRange(
  period: Period,
  tz: string,
): {
  startStr: string | null;
  endStr: string | null;
} {
  const now = dayjs().tz(tz);

  if (period === "month") {
    const prev = now.subtract(1, "month");
    return {
      startStr: prev.startOf("month").format(DATE_FMT),
      endStr: prev.endOf("month").format(DATE_FMT),
    };
  }

  if (period === "quarter") {
    const prevQuarterMonth = now.month(Math.floor(now.month() / 3) * 3).subtract(3, "month");
    return {
      startStr: prevQuarterMonth.startOf("month").format(DATE_FMT),
      endStr: prevQuarterMonth.add(2, "month").endOf("month").format(DATE_FMT),
    };
  }

  if (period === "year") {
    const prev = now.subtract(1, "year");
    return {
      startStr: prev.startOf("year").format(DATE_FMT),
      endStr: prev.endOf("year").format(DATE_FMT),
    };
  }

  return { startStr: null, endStr: null };
}

function monthsSince(startDate: Date | null): number {
  const start = startDate ?? new Date();
  const now = new Date();
  const diff =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth()) +
    1;
  return Math.max(1, diff);
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

async function fetchHoursByStaff(
  organizationId: string,
  staffIds: string[],
  startStr: string | null,
  endStr: string | null,
): Promise<Record<string, number>> {
  if (staffIds.length === 0) return {};

  const rows = await db
    .select({
      staffId: timeEntries.staffId,
      total: sum(timeEntries.hoursWorked),
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        inArray(timeEntries.staffId, staffIds),
        startStr ? gte(timeEntries.entryDate, startStr) : undefined,
        endStr ? lte(timeEntries.entryDate, endStr) : undefined,
      ),
    )
    .groupBy(timeEntries.staffId);

  return Object.fromEntries(
    rows.map((r) => [r.staffId, parseFloat(r.total ?? "0")]),
  );
}

const CERT_LEVEL_ORDER: Record<string, number> = {
  basic: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
};
const CERT_LEVEL_LABEL: Record<number, string> = {
  1: "basic",
  2: "intermediate",
  3: "advanced",
  4: "expert",
};

async function fetchSkillLevelByStaff(
  staffIds: string[],
): Promise<Record<string, string>> {
  if (staffIds.length === 0) return {};

  const rows = await db
    .select({
      staffId: staffCertifications.staffId,
      level: certifications.level,
    })
    .from(staffCertifications)
    .innerJoin(
      certifications,
      eq(certifications.id, staffCertifications.certificationId),
    )
    .where(inArray(staffCertifications.staffId, staffIds));

  const maxLevel: Record<string, number> = {};
  for (const row of rows) {
    const order = CERT_LEVEL_ORDER[row.level] ?? 0;
    if (!maxLevel[row.staffId] || order > maxLevel[row.staffId]) {
      maxLevel[row.staffId] = order;
    }
  }

  return Object.fromEntries(
    Object.entries(maxLevel).map(([id, order]) => [
      id,
      CERT_LEVEL_LABEL[order] ?? "basic",
    ]),
  );
}

// ─── Main Analytics ───────────────────────────────────────────────────────────

export const getRevenueAnalytics = async (
  organizationId: string,
  period: Period = "month",
  teamId?: string,
) => {
  const tz = await getFirmTimezone(organizationId);
  const { startStr, endStr, label, months } = getPeriodRange(period, tz);
  const prevRange = getPreviousPeriodRange(period, tz);

  const baseConditions = and(
    eq(staff.organizationId, organizationId),
    eq(staff.status, "active"),
  );

  const staffList = teamId
    ? await db
        .select({ staff })
        .from(staff)
        .innerJoin(teamMembers, eq(teamMembers.staffId, staff.id))
        .where(and(baseConditions, eq(teamMembers.teamId, teamId)))
        .then((rows) => rows.map((r) => r.staff))
    : await db.select().from(staff).where(baseConditions);

  if (staffList.length === 0) {
    return {
      periodLabel: label,
      summary: {
        totalRevenue: 0,
        totalSalaries: 0,
        overallROI: 0,
        totalHours: 0,
        totalStaff: 0,
        revenueTrend: null,
      },
      charts: {
        revenueVsSalary: [],
        revenueDistribution: [],
        efficiencyChart: [],
      },
      staff: [],
    };
  }

  const staffIds = staffList.map((s) => s.id);

  const [hoursByStaff, prevHoursByStaff, skillLevels] = await Promise.all([
    fetchHoursByStaff(organizationId, staffIds, startStr, endStr),
    prevRange.startStr
      ? fetchHoursByStaff(
          organizationId,
          staffIds,
          prevRange.startStr,
          prevRange.endStr,
        )
      : Promise.resolve({} as Record<string, number>),
    fetchSkillLevelByStaff(staffIds),
  ]);

  const staffMetrics = await Promise.all(
    staffList.map(async (s) => {
      const hourlyRate = parseFloat(s.hourlyRate ?? "0");
      const monthlySalary = parseFloat(s.monthlySalary ?? "0");
      const hours = hoursByStaff[s.id] ?? 0;
      const periodMonths = period === "all" ? monthsSince(s.startDate) : months;
      const salary = monthlySalary * periodMonths;
      const revenue = hours * hourlyRate;
      const profit = revenue - salary;
      const roi = salary > 0 ? ((revenue - salary) / salary) * 100 : 0;
      const revenuePerHour = hours > 0 ? revenue / hours : 0;
      const salaryPerHour = hours > 0 ? salary / hours : 0;

      return {
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        role: s.role,
        avatarUrl: await resolveAvatarUrl(s.avatarUrl),
        skillLevel: skillLevels[s.id] ?? null,
        revenue: Math.round(revenue),
        salary: Math.round(salary),
        profit: Math.round(profit),
        roi: Math.round(roi * 10) / 10,
        hours: Math.round(hours * 10) / 10,
        revenuePerHour: Math.round(revenuePerHour),
        salaryPerHour: Math.round(salaryPerHour),
      };
    }),
  );

  const totalRevenue = staffMetrics.reduce((acc, s) => acc + s.revenue, 0);
  const totalSalaries = staffMetrics.reduce((acc, s) => acc + s.salary, 0);
  const totalHours = staffMetrics.reduce((acc, s) => acc + s.hours, 0);
  const overallROI =
    totalSalaries > 0
      ? Math.round(((totalRevenue - totalSalaries) / totalSalaries) * 1000) / 10
      : 0;

  let revenueTrend: number | null = null;
  if (prevRange.startStr) {
    const prevRevenue = staffList.reduce((acc, s) => {
      const hours = prevHoursByStaff[s.id] ?? 0;
      const rate = parseFloat(s.hourlyRate ?? "0");
      return acc + hours * rate;
    }, 0);
    if (prevRevenue > 0) {
      revenueTrend =
        Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 1000) / 10;
    }
  }

  const staffWithShare = staffMetrics.map((s) => ({
    ...s,
    revenueShare:
      totalRevenue > 0 ? Math.round((s.revenue / totalRevenue) * 1000) / 10 : 0,
  }));

  return {
    periodLabel: label,
    summary: {
      totalRevenue: Math.round(totalRevenue),
      totalSalaries: Math.round(totalSalaries),
      overallROI,
      totalHours: Math.round(totalHours * 10) / 10,
      totalStaff: staffList.length,
      revenueTrend,
    },
    charts: {
      revenueVsSalary: staffWithShare.map((s) => ({
        name: s.firstName,
        revenue: s.revenue,
        salary: s.salary,
        profit: s.profit,
      })),
      revenueDistribution: staffWithShare.map((s) => ({
        name: s.firstName,
        percentage: s.revenueShare,
      })),
      efficiencyChart: staffWithShare.map((s) => ({
        name: s.firstName,
        revenuePerHour: s.revenuePerHour,
        salaryPerHour: s.salaryPerHour,
      })),
    },
    staff: staffWithShare,
  };
};

export class RevenueAnalyticsService {
  getRevenueAnalytics = getRevenueAnalytics;
}
