import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { member } from "../../db/schema/auth-schema";
import { financialAccessControls } from "../../db/schema/financial-access-controls";
import { staff } from "../../db/schema/staff";
import { getRequestContext } from "../../middleware/request-context";
import { AuthorizationError } from "../../utils/error/app-error";
import type { AccountAccess, AccountLevel, FinanceRestrictions } from "./types";

/**
 * Who may see and touch trust (IOLTA) money.
 *
 * `financial_access_controls` already exists — (organization, accountType,
 * role) -> permission, configured per firm via /settings/financial-access. The
 * coarse `finance: ["trust"]` Better Auth permission says whether the role may
 * ever see trust data; this table is the firm's own fine-grained answer. Both
 * are checked.
 *
 * Deny-by-default on trust: money the firm merely holds is the money a firm
 * gets disbarred for mishandling, so an unconfigured firm sees none of it.
 * Operating defaults open — that is the firm's own revenue.
 */

const TRUST_DEFAULT: AccountLevel = "no_access";
const OPERATING_DEFAULT: AccountLevel = "full_access";

/**
 * `permission_role_enum` is (admin | attorney | paralegal | client) — there is
 * no `owner` value, and an org owner may not have a staff row at all. Owners
 * are resolved as `admin` for this lookup.
 */
const toPermissionRole = (
  role: string | null | undefined,
): "admin" | "attorney" | "paralegal" | "client" | null => {
  switch (role) {
    case "owner":
    case "admin":
      return "admin";
    case "attorney":
      return "attorney";
    case "paralegal":
      return "paralegal";
    case "client":
      return "client";
    default:
      return null;
  }
};

/** `permission_level_enum` is broader than the three levels that matter here. */
const toAccountLevel = (permission: string | null): AccountLevel => {
  switch (permission) {
    case "full_access":
    case "payments":
      return "full_access";
    case "view_only":
      return "view_only";
    default:
      return "no_access";
  }
};

export const resolveAccountAccess = async (
  organizationId: string,
  role: string | null | undefined,
): Promise<AccountAccess> => {
  const permissionRole = toPermissionRole(role);

  // No recognised role means no configured grant to find. Operating stays open
  // (an authenticated staff member of the firm), trust stays closed.
  if (!permissionRole) {
    return { operating: OPERATING_DEFAULT, trust: TRUST_DEFAULT };
  }

  const rows = await db
    .select({
      accountType: financialAccessControls.accountType,
      permission: financialAccessControls.permission,
    })
    .from(financialAccessControls)
    .where(
      and(
        eq(financialAccessControls.organizationId, organizationId),
        eq(financialAccessControls.role, permissionRole),
      ),
    );

  let operating: AccountLevel = OPERATING_DEFAULT;
  let trust: AccountLevel = TRUST_DEFAULT;

  for (const row of rows) {
    if (row.accountType === "operating") operating = toAccountLevel(row.permission);
    if (row.accountType === "trust_iolta") trust = toAccountLevel(row.permission);
  }

  return { operating, trust };
};

/**
 * Which of the two role columns actually classifies someone for finance.
 *
 * Better Auth's `member.role` is org membership: `owner`, `admin`, or the
 * generic `member`. `staff.role` is the professional role
 * (admin | attorney | paralegal), and it is what `financial_access_controls`
 * is keyed on.
 *
 * Preferring `member.role` outright was wrong. Most staff carry
 * `member.role = 'member'`, which is truthy, so a `?? staff.role` fallback
 * never fired; `toPermissionRole('member')` then returned null and
 * `resolveAccountAccess` returned early WITHOUT reading the table. Every
 * attorney and paralegal silently got the defaults no matter what the firm had
 * configured for their role.
 *
 * So: take `member.role` only when it carries org privilege (owner/admin —
 * also the only place `owner` exists, and where an owner may have no staff row
 * at all), otherwise use `staff.role`, and fall back to `member.role` when
 * there is no staff row.
 */
export const pickFinanceRole = (
  memberRole: string | null | undefined,
  staffRole: string | null | undefined,
): string | null => {
  if (memberRole === "owner" || memberRole === "admin") return memberRole;
  if (staffRole) return staffRole;
  return memberRole ?? null;
};

/** Resolve the caller's access from the ambient request context. */
export const accessForRequest = async (): Promise<AccountAccess> => {
  const { organizationId, userId } = getRequestContext();
  if (!organizationId) {
    return { operating: OPERATING_DEFAULT, trust: TRUST_DEFAULT };
  }

  if (!userId) return resolveAccountAccess(organizationId, null);

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

  return resolveAccountAccess(
    organizationId,
    pickFinanceRole(membership?.role, staffRow?.role),
  );
};

/** Can the caller see trust figures at all? */
export const canReadTrust = (access: AccountAccess): boolean =>
  access.trust !== "no_access";

/** Can the caller create trust lines or record trust payments? */
export const canWriteTrust = (access: AccountAccess): boolean =>
  access.trust === "full_access";

/**
 * Guard for the write paths.
 *
 * Enforced in the service rather than by a route guard, because whether a
 * request touches trust money depends on the body (a line's account, a
 * payment's trust amount), not on the route.
 */
export const requireTrustWrite = (access: AccountAccess): void => {
  if (!canWriteTrust(access)) {
    throw new AuthorizationError(
      "You do not have access to trust (IOLTA) account data",
    );
  }
};

export const restrictionsFor = (access: AccountAccess): FinanceRestrictions => ({
  trust: access.trust,
});

/**
 * Trust figures are OMITTED (null), never zeroed, when the caller cannot see
 * them. Zeroing lies; a null plus the `restrictions` block lets the UI render
 * an em-dash or hide the panel entirely.
 *
 * Note the deliberate asymmetry with aggregate totals: `totalInvoiced` keeps
 * including trust amounts even when the split is hidden. Hiding both would
 * produce a "total" that disagrees with the sum of the visible rows.
 */
export const maskTrust = <T>(access: AccountAccess, value: T): T | null =>
  canReadTrust(access) ? value : null;
