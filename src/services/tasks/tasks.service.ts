import { and, count, desc, eq, gte, lte, or } from "drizzle-orm";
import { db } from "../../db/client";
import { admins } from "../../db/schema/admins";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { staff } from "../../db/schema/staff";
import { tasks } from "../../db/schema/tasks";

// ─── Stats ───────────────────────────────────────────────────────────────────

export const getTaskStats = async (firmId: string) => {
  const [activeResult] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.firmId, firmId),
        or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
      ),
    );

  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const [completedResult] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.firmId, firmId),
        eq(tasks.status, "completed"),
        gte(tasks.updatedAt, startOfWeek),
      ),
    );

  const [highPriorityResult] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.firmId, firmId),
        or(eq(tasks.priority, "high"), eq(tasks.priority, "critical")),
        or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
      ),
    );

  const todayStr = new Date().toISOString().split("T")[0];
  const endOfWeekStr = endOfWeek.toISOString().split("T")[0];

  const [dueThisWeekResult] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.firmId, firmId),
        gte(tasks.dueDate, todayStr),
        lte(tasks.dueDate, endOfWeekStr),
        or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
      ),
    );

  return {
    activeTasks: activeResult.count,
    completedThisWeek: completedResult.count,
    highPriority: highPriorityResult.count,
    dueThisWeek: dueThisWeekResult.count,
  };
};

// ─── Shared select + joins ────────────────────────────────────────────────────

const taskSelect = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  teamId: tasks.teamId,
  dueDate: tasks.dueDate,
  priority: tasks.priority,
  status: tasks.status,
  progress: tasks.progress,
  requiredCertifications: tasks.requiredCertifications,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  caseId: cases.id,
  caseNumber: cases.caseNumber,
  caseType: cases.caseType,
  clientId: clients.id,
  clientFirstName: clients.firstName,
  clientLastName: clients.lastName,
  assignedToId: staff.id,
  assignedToFirstName: staff.firstName,
  assignedToLastName: staff.lastName,
  assignedToRole: staff.role,
  assignedByFirstName: admins.firstName,
  assignedByLastName: admins.lastName,
};

const withJoins = (query: any) =>
  query
    .leftJoin(cases, eq(cases.id, tasks.caseId))
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(staff, eq(staff.id, tasks.assignedToId))
    .leftJoin(admins, eq(admins.id, tasks.assignedById));

const formatRow = (r: any) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  teamId: r.teamId,
  dueDate: r.dueDate,
  priority: r.priority,
  status: r.status,
  progress: r.progress,
  requiredCertifications: r.requiredCertifications,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  case: {
    id: r.caseId,
    caseNumber: r.caseNumber,
    caseType: r.caseType,
  },
  client: {
    id: r.clientId,
    name: `${r.clientFirstName} ${r.clientLastName}`,
  },
  assignedTo: r.assignedToId
    ? {
        id: r.assignedToId,
        name: `${r.assignedToFirstName} ${r.assignedToLastName}`,
        role: r.assignedToRole,
      }
    : null,
  assignedBy: r.assignedByFirstName
    ? { name: `${r.assignedByFirstName} ${r.assignedByLastName}` }
    : null,
});

// ─── Tasks CRUD ───────────────────────────────────────────────────────────────

export const getAllTasks = async (
  firmId: string,
  filters?: {
    search?: string;
    status?: string;
    priority?: string;
    assignedToId?: string;
  },
) => {
  const rows = await withJoins(db.select(taskSelect).from(tasks))
    .where(eq(tasks.firmId, firmId))
    .orderBy(desc(tasks.createdAt));

  return rows
    .filter((r: any) => {
      if (filters?.status && r.status !== filters.status) return false;
      if (filters?.priority && r.priority !== filters.priority) return false;
      if (filters?.assignedToId && r.assignedToId !== filters.assignedToId)
        return false;
      if (filters?.search) {
        const q = filters.search.toLowerCase();
        const matches =
          r.title.toLowerCase().includes(q) ||
          r.clientFirstName?.toLowerCase().includes(q) ||
          r.clientLastName?.toLowerCase().includes(q) ||
          r.caseType?.toLowerCase().includes(q) ||
          r.caseNumber?.toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    })
    .map(formatRow);
};

export const getTaskById = async (id: string, firmId: string) => {
  const [row] = await withJoins(db.select(taskSelect).from(tasks)).where(
    and(eq(tasks.id, id), eq(tasks.firmId, firmId)),
  );

  return row ? formatRow(row) : null;
};

export const createTask = async (data: {
  firmId: string;
  title: string;
  description: string;
  caseId: string;
  teamId?: string;
  assignedToId: string;
  assignedById: string;
  dueDate: string;
  priority?: string;
  requiredCertifications?: string[];
}) => {
  const [newTask] = await db
    .insert(tasks)
    .values({
      firmId: data.firmId,
      title: data.title,
      description: data.description,
      caseId: data.caseId,
      teamId: data.teamId,
      assignedToId: data.assignedToId,
      assignedById: data.assignedById,
      dueDate: data.dueDate,
      priority: (data.priority ?? "medium") as any,
      requiredCertifications: data.requiredCertifications ?? [],
    })
    .returning();

  return newTask;
};

export const updateTask = async (
  id: string,
  firmId: string,
  data: Partial<typeof tasks.$inferInsert>,
) => {
  const [updated] = await db
    .update(tasks)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.firmId, firmId)))
    .returning();

  return updated ?? null;
};

export const deleteTask = async (id: string, firmId: string) => {
  await db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.firmId, firmId)));
};
