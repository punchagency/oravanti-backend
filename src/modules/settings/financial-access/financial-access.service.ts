import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { financialAccessControls } from "../../../db/schema";
import {
  accountTypeEnum,
  permissionLevelEnum,
  permissionRoleEnum,
} from "../../../db/schema/financial-access-controls";
import { member } from "../../../db/schema/auth-schema";
import { staff } from "../../../db/schema/staff";
import { getRequestContext } from "../../../middleware/request-context";
import {
  pickFinanceRole,
  resolveAccountAccess,
} from "../../finance/account-access";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";
import { BadRequestError } from "../../../utils/error/app-error";

const log = createModuleLogger("financial-access.service");

// Taken from the enums themselves rather than restated, so a value added to the
// schema cannot be silently rejected here.
const ACCOUNT_TYPES = accountTypeEnum.enumValues;
const PERMISSION_ROLES = permissionRoleEnum.enumValues;
const PERMISSION_LEVELS = permissionLevelEnum.enumValues;

type AccountType = (typeof ACCOUNT_TYPES)[number];
type PermissionRole = (typeof PERMISSION_ROLES)[number];
type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export class FinancialAccessService {
  /**
   * The firm's matrix, plus where the CALLER sits in it.
   *
   * `viewer` is resolved server-side rather than left to the client. The
   * settings page needs it to warn an admin who is about to remove their own
   * trust access, and deriving it in the browser would mean a second copy of
   * the `member.role` vs `staff.role` rule that `pickFinanceRole` exists to
   * hold — a rule that has already shipped wrong once, silently giving every
   * attorney and paralegal the defaults no matter what the firm configured.
   */
  getFinancialAccess = async (organizationId: string) => {
    const rows = await db
      .select()
      .from(financialAccessControls)
      .where(eq(financialAccessControls.organizationId, organizationId));

    const controls = rows.reduce(
      (acc, row) => {
        if (!acc[row.accountType]) acc[row.accountType] = {};
        acc[row.accountType]![row.role] = row.permission;
        return acc;
      },
      {} as Record<string, Record<string, string>>,
    );

    return { controls, viewer: await this.viewer(organizationId) };
  };

  private viewer = async (organizationId: string) => {
    const { userId } = getRequestContext();
    if (!userId) return { financeRole: null, trust: "no_access" as const };

    const [[membership], [staffRow]] = await Promise.all([
      db
        .select({ role: member.role })
        .from(member)
        .where(
          and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
        )
        .limit(1),
      db
        .select({ role: staff.role })
        .from(staff)
        .where(
          and(eq(staff.userId, userId), eq(staff.organizationId, organizationId)),
        )
        .limit(1),
    ]);

    const financeRole = pickFinanceRole(membership?.role, staffRow?.role);
    const access = await resolveAccountAccess(organizationId, financeRole);

    return { financeRole, trust: access.trust };
  };

  /**
   * Set the firm's financial-access matrix.
   *
   * **An upsert, not an update.** This was an `UPDATE ... WHERE`, which matches
   * nothing when the firm has no row for that (account, role) — and no firm had
   * any, because the seed that creates them was never called from onboarding.
   * So the endpoint wrote nothing, recorded an audit event, logged success, and
   * returned 200. A firm locked out of its own trust data had no way to grant
   * access, and no indication why.
   *
   * Values are validated against the enums before the write: the route's
   * `requiredArrayBody("controls")` checks that the body holds a non-empty
   * array, not what is inside it, and these three columns are Postgres enums —
   * an unrecognised string is a 500 from the driver rather than a 400 telling
   * the caller what was wrong.
   */
  updateFinancialAccess = async (
    organizationId: string,
    controls: { accountType: string; role: string; permission: string }[],
  ) => {
    const rows = controls.map((c, i) => {
      const at = c?.accountType;
      const role = c?.role;
      const permission = c?.permission;

      if (!ACCOUNT_TYPES.includes(at as AccountType)) {
        throw new BadRequestError(
          `controls[${i}].accountType must be one of ${ACCOUNT_TYPES.join(", ")}`,
        );
      }
      if (!PERMISSION_ROLES.includes(role as PermissionRole)) {
        throw new BadRequestError(
          `controls[${i}].role must be one of ${PERMISSION_ROLES.join(", ")}`,
        );
      }
      if (!PERMISSION_LEVELS.includes(permission as PermissionLevel)) {
        throw new BadRequestError(
          `controls[${i}].permission must be one of ${PERMISSION_LEVELS.join(", ")}`,
        );
      }

      return {
        organizationId,
        accountType: at as AccountType,
        role: role as PermissionRole,
        permission: permission as PermissionLevel,
        updatedAt: new Date(),
      };
    });

    // One statement, so a partly-applied matrix is not a possible outcome.
    // Conflict target is the existing unique (organization, accountType, role).
    await db
      .insert(financialAccessControls)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          financialAccessControls.organizationId,
          financialAccessControls.accountType,
          financialAccessControls.role,
        ],
        set: {
          permission: sql`excluded.permission`,
          updatedAt: new Date(),
        },
      });
    await recordAuditEvent({
      action: "admin.financial_access_changed",
      entityId: organizationId,
      entityType: "permission",
      onWriteFailure: "log",
    });
    log.action("settings.financial_access_updated", { organizationId });
  };
}
