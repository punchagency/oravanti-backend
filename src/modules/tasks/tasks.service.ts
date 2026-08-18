import { and, count, desc, eq, gte, lte, or } from "drizzle-orm";
import { db } from "../../db/client";
import type { UpdateTaskInput } from "./tasks.validation";
import { admins, cases, clients, staff, tasks } from "../../db/schema";
import { assertAssignableStaff } from "../../utils/assignable-staff";
import { dayjs } from "../../utils/date";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";
import { recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("tasks.service");

export class TasksService {
  // ─── Stats ───────────────────────────────────────────────────────────────────

  getTaskStats = async (organizationId: string) => {
    const [activeResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
        ),
      );

    // "This week" is bounded by the firm's local calendar week.
    const tz = await getFirmTimezone(organizationId);
    const weekStart = dayjs().tz(tz).startOf("week");
    const startOfWeek = weekStart.utc().toDate();
    const endOfWeek = weekStart.endOf("week").utc().toDate();

    const [completedResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          eq(tasks.status, "completed"),
          gte(tasks.updatedAt, startOfWeek),
        ),
      );

    const [highPriorityResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
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
          eq(tasks.organizationId, organizationId),
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

  taskSelect = {
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
    caseTypeId: cases.caseTypeId,
    clientId: clients.id,
    clientDisplayName: clients.displayName,
    assignedToId: staff.id,
    assignedToFirstName: staff.firstName,
    assignedToLastName: staff.lastName,
    assignedToRole: staff.role,
    assignedByFirstName: admins.firstName,
    assignedByLastName: admins.lastName,
  };

  withJoins = (query: any) =>
    query
      .leftJoin(cases, eq(cases.id, tasks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .leftJoin(staff, eq(staff.id, tasks.assignedToId))
      .leftJoin(admins, eq(admins.id, tasks.assignedById));

  formatRow = (r: any) => ({
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
      caseType: r.caseTypeId,
    },
    client: {
      id: r.clientId,
      name: r.clientDisplayName ?? '',
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

  getAllTasks = async (
    organizationId: string,
    filters?: {
      search?: string;
      status?: string;
      priority?: string;
      assignedToId?: string;
    },
  ) => {
    const rows = await this.withJoins(db.select(this.taskSelect).from(tasks))
      .where(eq(tasks.organizationId, organizationId))
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
      .map(this.formatRow);
  };

  getTaskById = async (id: string, organizationId: string) => {
    const [row] = await this.withJoins(
      db.select(this.taskSelect).from(tasks),
    ).where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)));

    return row ? this.formatRow(row) : null;
  };

  createTask = async (data: {
    organizationId: string;
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
    await assertAssignableStaff(data.assignedToId, data.organizationId);

    const [newTask] = await db
      .insert(tasks)
      .values({
        organizationId: data.organizationId,
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

    await recordAuditEvent({
      action: "task.created",
      entityId: newTask.id,
      summary: `Task created: ${newTask.title}`,
      after: { title: newTask.title, status: newTask.status, priority: newTask.priority },
      onWriteFailure: "log",
    });

    log.action("task.created", { taskId: newTask.id });

    return newTask;
  };

  updateTask = async (
    id: string,
    organizationId: string,
    data: UpdateTaskInput,
  ) => {
    const [updated] = await db
      .update(tasks)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)))
      .returning();

    if (updated) {
      await recordAuditEvent({
        action: "task.updated",
        entityId: updated.id,
        summary: `Task updated: ${updated.title}`,
        after: { title: updated.title, status: updated.status, priority: updated.priority },
        onWriteFailure: "log",
      });
    }

    log.action("task.updated", { taskId: id });

    return updated ?? null;
  };

  deleteTask = async (id: string, organizationId: string) => {
    await db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)));

    log.action("task.deleted", { taskId: id });
  };
}
