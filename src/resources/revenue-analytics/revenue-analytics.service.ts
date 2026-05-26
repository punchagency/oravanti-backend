import { and, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { teamMembers } from "../../db/schema";
import { certifications } from "../../db/schema/certifications";
import { staff } from "../../db/schema/staff";
import { staffCertifications } from "../../db/schema/staff-certifications";
import { timeEntries } from "../../db/schema/time-entries";
import { db } from "./../../db/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Period = "month" | "quarter" | "year" | "all";

// ─── Period Helpers ───────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

function getPeriodRange(period: Period): {
  startStr: string | null;
  endStr: string | null;
  label: string;
  months: number;
} {
  const now = new Date();

  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const label = `${start.toLocaleString("en-US", { month: "long" })} ${now.getFullYear()}`;
    return {
      startStr: toDateStr(start),
      endStr: toDateStr(end),
      label,
      months: 1,
    };
  }

  if (period === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const start = new Date(now.getFullYear(), q * 3, 1);
    const end = new Date(now.getFullYear(), (q + 1) * 3, 0);
    const MONTHS = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const label = `Q${q + 1} ${now.getFullYear()} (${MONTHS[q * 3]} - ${MONTHS[q * 3 + 2]})`;
    return {
      startStr: toDateStr(start),
      endStr: toDateStr(end),
      label,
      months: 3,
    };
  }

  if (period === "year") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), 11, 31);
    return {
      startStr: toDateStr(start),
      endStr: toDateStr(end),
      label: String(now.getFullYear()),
      months: 12,
    };
  }

  return { startStr: null, endStr: null, label: "All Time", months: 0 };
}

function getPreviousPeriodRange(period: Period): {
  startStr: string | null;
  endStr: string | null;
} {
  const now = new Date();

  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { startStr: toDateStr(start), endStr: toDateStr(end) };
  }

  if (period === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const prevQ = q - 1;
    if (prevQ < 0) {
      const start = new Date(now.getFullYear() - 1, 9, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return { startStr: toDateStr(start), endStr: toDateStr(end) };
    }
    const start = new Date(now.getFullYear(), prevQ * 3, 1);
    const end = new Date(now.getFullYear(), (prevQ + 1) * 3, 0);
    return { startStr: toDateStr(start), endStr: toDateStr(end) };
  }

  if (period === "year") {
    const start = new Date(now.getFullYear() - 1, 0, 1);
    const end = new Date(now.getFullYear() - 1, 11, 31);
    return { startStr: toDateStr(start), endStr: toDateStr(end) };
  }

  return { startStr: null, endStr: null };
}

function monthsSince(startDateStr: string): number {
  const start = new Date(startDateStr);
  const now = new Date();
  const diff =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth()) +
    1;
  return Math.max(1, diff);
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

async function fetchHoursByStaff(
  firmId: string,
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
        eq(timeEntries.firmId, firmId),
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
      eq(certifications.code, staffCertifications.certificationCode),
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
  firmId: string,
  period: Period = "month",
  teamId?: string,
) => {
  const { startStr, endStr, label, months } = getPeriodRange(period);
  const prevRange = getPreviousPeriodRange(period);

  const baseConditions = and(
    eq(staff.firmId, firmId),
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
    fetchHoursByStaff(firmId, staffIds, startStr, endStr),
    prevRange.startStr
      ? fetchHoursByStaff(
          firmId,
          staffIds,
          prevRange.startStr,
          prevRange.endStr,
        )
      : Promise.resolve({} as Record<string, number>),
    fetchSkillLevelByStaff(staffIds),
  ]);

  const staffMetrics = staffList.map((s) => {
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
      avatarUrl: s.avatarUrl,
      skillLevel: skillLevels[s.id] ?? null,
      revenue: Math.round(revenue),
      salary: Math.round(salary),
      profit: Math.round(profit),
      roi: Math.round(roi * 10) / 10,
      hours: Math.round(hours * 10) / 10,
      revenuePerHour: Math.round(revenuePerHour),
      salaryPerHour: Math.round(salaryPerHour),
    };
  });

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
