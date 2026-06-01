import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/client";
import { clients, modulePermissions, staff } from "../../../db/schema";

export class AccessControlService {
  getRoleOverview = async (organizationId: string) => {
    const [adminCount, attorneyCount, paralegalCount, clientCount] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(staff)
          .where(and(eq(staff.organizationId, organizationId), eq(staff.role, "admin"))),
        db
          .select({ count: count() })
          .from(staff)
          .where(and(eq(staff.organizationId, organizationId), eq(staff.role, "attorney"))),
        db
          .select({ count: count() })
          .from(staff)
          .where(
            and(
              eq(staff.organizationId, organizationId),
              inArray(staff.role, [
                "junior_paralegal",
                "paralegal",
                "senior_paralegal",
              ]),
            ),
          ),
        db
          .select({ count: count() })
          .from(clients)
          .where(eq(clients.organizationId, organizationId)),
      ]);

    return {
      admin: {
        count: adminCount[0].count,
        description: "Full system access",
      },
      attorney: {
        count: attorneyCount[0].count,
        description: "Review & approve cases",
      },
      paralegal: {
        count: paralegalCount[0].count,
        description: "Case preparation",
      },
      client: {
        count: clientCount[0].count,
        description: "Limited portal access",
      },
    };
  };

  getPermissions = async (organizationId: string) => {
    const rows = await db
      .select()
      .from(modulePermissions)
      .where(eq(modulePermissions.organizationId, organizationId));

    return rows.reduce(
      (acc, row) => {
        if (!acc[row.module]) acc[row.module] = {};
        acc[row.module][row.role] = row.permission;
        return acc;
      },
      {} as Record<string, Record<string, string>>,
    );
  };

  savePermissions = async (
    organizationId: string,
    permissions: { module: string; role: string; permission: string }[],
  ) => {
    await Promise.all(
      permissions.map((p) =>
        db
          .update(modulePermissions)
          .set({ permission: p.permission as any, updatedAt: new Date() })
          .where(
            and(
              eq(modulePermissions.organizationId, organizationId),
              eq(modulePermissions.module, p.module as any),
              eq(modulePermissions.role, p.role as any),
            ),
          ),
      ),
    );
  };
}
