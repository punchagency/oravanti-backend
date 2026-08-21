import { APIError } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { auth } from "../../../auth";
import {
  ac,
  clientPermissions,
  contractorPermissions,
  DEFAULT_ROLE_NAMES,
  DEFAULT_ROLE_PERMISSIONS,
  isValidRoleColor,
  admin,
  owner,
  ROLE_METADATA,
  type DefaultRoleName,
} from "../../../auth/permissions";
import { seedDefaultRoleRows } from "../../../auth/seed-default-roles";
import { db } from "../../../db/client";
import { member, user } from "../../../db/schema/auth-schema";
import { roleAppearance } from "../../../db/schema/role-appearance";
import {
  AuthorizationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../utils/error/app-error";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";
import { LogEvent } from "../../../lib/logging/events";
import { resolveMemberGrants } from "../../shared/member-grants.service";
import { parsePaginationQuery } from "../../../utils/pagination";

const log = createModuleLogger("roles-permissions.service");

type Headers = Record<string, string | string[] | undefined>;

const asHeaders = (headers: Headers) =>
  fromNodeHeaders(headers as Record<string, string>);

/** The full resource:action vocabulary — the fixed columns of the matrix. */
const RESOURCE_ACTIONS = ac.statements as Record<string, readonly string[]>;

const isDefaultRoleName = (name: string): name is DefaultRoleName =>
  (DEFAULT_ROLE_NAMES as readonly string[]).includes(name);

// Only `owner` is locked — never editable, never deletable, always full
// access. The four default roles are real, DB-backed rows: editable and
// resettable, just not deletable (see `deleteRole`/`resetRole` below).
const isLockedRole = (roleName: string) => roleName === "owner";

/**
 * better-auth's dynamicAccessControl endpoints throw their own `APIError`
 * for entirely expected failures — a duplicate role name, a role deleted
 * out from under a concurrent edit. Left uncaught, that reaches the global
 * error handler as an unrecognized error type and surfaces to the client as
 * an opaque 500 rather than the specific, actionable message better-auth
 * already wrote. Translates the ones a caller can actually hit here into
 * our own typed `AppError`s; anything unrecognized is rethrown as-is.
 */
function translateRoleApiError(error: unknown): never {
  if (error instanceof APIError) {
    const code = (error.body as { code?: string } | undefined)?.code;
    switch (code) {
      case "ROLE_NAME_IS_ALREADY_TAKEN":
        throw new ConflictError(error.message);
      case "ROLE_NOT_FOUND":
        throw new NotFoundError(error.message);
      case "TOO_MANY_ROLES":
      case "INVALID_RESOURCE":
      case "ROLE_IS_ASSIGNED_TO_MEMBERS":
        throw new BadRequestError(error.message);
      case "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_ROLE":
      case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_A_ROLE":
      case "YOU_ARE_NOT_ALLOWED_TO_DELETE_A_ROLE":
      case "CANNOT_DELETE_A_PRE_DEFINED_ROLE":
        throw new AuthorizationError(error.message);
    }
  }
  throw error;
}

async function countMembersPerRole(organizationId: string) {
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(eq(member.organizationId, organizationId));

  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const roleName of row.role.split(",").map((r) => r.trim())) {
      if (!roleName) continue;
      counts[roleName] = (counts[roleName] ?? 0) + 1;
    }
  }
  return counts;
}

export class RolesPermissionsService {
  /**
   * `owner` (fully static, never in the DB) plus every DB-backed role for
   * this org — the four seeded defaults (attorney, paralegal,
   * legal_assistant, receptionist), the static `admin` role, and any
   * firm-created custom role — merged with live staff counts and accent
   * colors. `owner` and `admin` are not DB-backed rows, so they are
   * prepended here rather than coming out of `listOrgRoles`.
   */
  getRoles = async (organizationId: string, headers: Headers) => {
    await seedDefaultRoleRows(organizationId);

    const [dbRoles, counts, appearances] = await Promise.all([
      auth.api.listOrgRoles({
        query: { organizationId },
        headers: asHeaders(headers),
      }) as Promise<Array<{ role: string; permission: unknown }>>,
      countMembersPerRole(organizationId),
      this.getRoleAppearance(organizationId),
    ]);

    const ownerSummary = {
      name: "owner",
      label: ROLE_METADATA.owner?.label ?? "owner",
      description: ROLE_METADATA.owner?.description ?? "",
      locked: true,
      isDefault: true,
      staffCount: counts.owner ?? 0,
      grants: (owner as unknown as { statements: Record<string, string[]> }).statements,
      color: appearances.owner?.color ?? null,
    };

    const adminSummary = {
      name: "admin",
      label: ROLE_METADATA.admin?.label ?? "admin",
      description: appearances.admin?.description || (ROLE_METADATA.admin?.description ?? ""),
      locked: false,
      // A default role in every sense the UI cares about (type filter,
      // "Default" badge) — it just isn't DB-backed, so it isn't seeded and
      // can't be reset like the four seeded defaults can.
      isDefault: true,
      staffCount: counts.admin ?? 0,
      grants: (admin as unknown as { statements: Record<string, string[]> }).statements,
      color: appearances.admin?.color ?? null,
    };

    const rows = dbRoles.map((r) => {
      const appearance = appearances[r.role];
      const metaDesc = isDefaultRoleName(r.role) ? (ROLE_METADATA[r.role]?.description ?? "") : "";
      return {
        name: r.role,
        label: isDefaultRoleName(r.role) ? (ROLE_METADATA[r.role]?.label ?? r.role) : r.role,
        description: appearance?.description || metaDesc,
        locked: false,
        isDefault: isDefaultRoleName(r.role),
        staffCount: counts[r.role] ?? 0,
        grants: r.permission as Record<string, string[]>,
        color: appearance?.color ?? null,
      };
    });

    const defaultOrder = DEFAULT_ROLE_NAMES as readonly string[];
    rows.sort((a, b) => {
      const ai = defaultOrder.indexOf(a.name);
      const bi = defaultOrder.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    return [ownerSummary, adminSummary, ...rows];
  };

  /**
   * Search / type-filter / pagination for the Roles tab — the server-side
   * counterpart of what this page used to do client-side. The role list is
   * merged from three sources (static owner/admin, better-auth org roles,
   * the appearance table), so this can't be a SQL WHERE; filtering happens
   * on the merged list, still before it ever reaches the client.
   *
   * `total` is the count AFTER filtering but BEFORE pagination — the number
   * a pager needs. Callers that omit `query` get every role and can ignore
   * `total`.
   */
  listRoles = async (
    organizationId: string,
    headers: Headers,
    query: { q?: string; type?: string; page?: number; limit?: number } = {},
  ) => {
    const allRoles = await this.getRoles(organizationId, headers);

    const q = query.q?.trim().toLowerCase();
    const filtered = allRoles.filter((role) => {
      if (query.type === "default" && !role.isDefault) return false;
      if (query.type === "custom" && role.isDefault) return false;
      if (!q) return true;
      return `${role.label} ${role.name} ${role.description}`.toLowerCase().includes(q);
    });

    if (query.page === undefined && query.limit === undefined) {
      return { roles: filtered, total: filtered.length };
    }

    const { page, limit } = parsePaginationQuery({
      page: query.page,
      limit: query.limit,
    });
    const start = (page - 1) * limit;
    return {
      roles: filtered.slice(start, start + limit),
      total: filtered.length,
    };
  };

  /**
   * Name + label only, for role-assignment dropdowns *outside* the RBAC
   * admin page (invite staff, edit staff). Those call sites never need
   * `grants`/`staffCount`/`color` — skipping them also skips the two extra
   * queries (`countMembersPerRole` scans the whole `member` table;
   * `getRoleAppearance` is a separate table) that `getRoles` pays for on
   * every call. Gated on `staffs:read` rather than `ac:read`, since ordinary
   * staff who can invite/edit colleagues generally can't manage roles.
   */
  listRoleOptions = async (organizationId: string, headers: Headers) => {
    await seedDefaultRoleRows(organizationId);

    const dbRoles = (await auth.api.listOrgRoles({
      query: { organizationId },
      headers: asHeaders(headers),
    })) as Array<{ role: string; permission: unknown }>;

    const rows = dbRoles.map((r) => ({
      name: r.role,
      label: isDefaultRoleName(r.role) ? (ROLE_METADATA[r.role]?.label ?? r.role) : r.role,
    }));

    const defaultOrder = DEFAULT_ROLE_NAMES as readonly string[];
    rows.sort((a, b) => {
      const ai = defaultOrder.indexOf(a.name);
      const bi = defaultOrder.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    return [
      { name: "owner", label: ROLE_METADATA.owner?.label ?? "owner" },
      { name: "admin", label: ROLE_METADATA.admin?.label ?? "admin" },
      ...rows,
    ];
  };

  /** Every role's accent color and description for this org, keyed by role name. */
  getRoleAppearance = async (
    organizationId: string,
  ): Promise<Record<string, { color: string; description: string }>> => {
    const rows = await db
      .select({
        roleName: roleAppearance.roleName,
        color: roleAppearance.color,
        description: roleAppearance.description,
      })
      .from(roleAppearance)
      .where(eq(roleAppearance.organizationId, organizationId));

    const result: Record<string, { color: string; description: string }> = {};
    for (const row of rows)
      result[row.roleName] = { color: row.color, description: row.description ?? "" };
    return result;
  };

  /**
   * Purely cosmetic — does not touch `ac`/`organizationRole` at all, so it
   * works uniformly for default and custom roles alike (defaults never have
   * an `organizationRole` row of their own to hang a color off).
   */
  setRoleColor = async (organizationId: string, roleName: string, color: string) => {
    if (!isValidRoleColor(color)) {
      throw new BadRequestError(`"${color}" is not a valid color — expected a hex code like #3B82F6`);
    }

    await db
      .insert(roleAppearance)
      .values({ organizationId, roleName, color })
      .onConflictDoUpdate({
        target: [roleAppearance.organizationId, roleAppearance.roleName],
        set: { color, updatedAt: new Date() },
      });

    return { roleName, color };
  };

  /**
   * The full permission vocabulary crossed with every role's grants, plus
   * two read-only reference columns for contractor and client — not real,
   * firm-assignable roles (no `member.role` ever holds these names; they're
   * gated through the static `clientPermissions`/`contractorPermissions`
   * fallback instead, see `requirePermission`), but worth showing here so
   * an admin can see the whole access picture in one matrix. `getRoles`
   * deliberately does not include them — they must never appear as role
   * cards or in the staff-assignment table.
   */
  getMatrix = async (organizationId: string, headers: Headers) => {
    const roles = await this.getRoles(organizationId, headers);
    const referenceRoles = [
      {
        name: "contractor",
        label: "Contractor",
        description: "External contractor account. Fixed, firm-wide permissions — not assignable here.",
        locked: false,
        isDefault: false,
        staffCount: 0,
        grants: contractorPermissions,
        color: null,
      },
      {
        name: "client",
        label: "Client",
        description: "Client portal account. Fixed, firm-wide permissions — not assignable here.",
        locked: false,
        isDefault: false,
        staffCount: 0,
        grants: clientPermissions,
        color: null,
      },
    ];
    return { resources: RESOURCE_ACTIONS, roles: [...roles, ...referenceRoles] };
  };

  createRole = async (
    organizationId: string,
    input: { role: string; permission: Record<string, string[]>; description?: string; color?: string },
    headers: Headers,
  ) => {
    if (input.role === "owner" || isDefaultRoleName(input.role)) {
      throw new BadRequestError(
        `"${input.role}" is a default role name — duplicate and rename it instead of reusing the name`,
      );
    }

    const created = await auth.api
      .createOrgRole({
        body: { role: input.role, permission: input.permission, organizationId },
        headers: asHeaders(headers),
      })
      .catch(translateRoleApiError);

    // Store description and color in roleAppearance if provided
    if (input.description || input.color) {
      const color = input.color && isValidRoleColor(input.color) ? input.color : "#6B7280";
      await db
        .insert(roleAppearance)
        .values({
          organizationId,
          roleName: input.role,
          color,
          description: input.description ?? "",
        })
        .onConflictDoUpdate({
          target: [roleAppearance.organizationId, roleAppearance.roleName],
          set: {
            ...(input.color && isValidRoleColor(input.color) ? { color: input.color } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            updatedAt: new Date(),
          },
        });
    }

    await recordAuditEvent({
      action: "role.created",
      entityId: input.role,
      entityType: "permission",
      after: { role: input.role, permission: input.permission },
      organizationId,
    });
    log.action(LogEvent.ROLE_CREATED, { organizationId, role: input.role });

    return created;
  };

  updateRole = async (
    organizationId: string,
    roleName: string,
    permission: Record<string, string[]>,
    headers: Headers,
    label?: string,
    description?: string,
  ) => {
    if (isLockedRole(roleName)) {
      throw new AuthorizationError(
        `"${ROLE_METADATA[roleName]?.label ?? roleName}" is a locked default role and cannot be edited`,
      );
    }

    const updated = await auth.api
      .updateOrgRole({
        body: { roleName, organizationId, data: { permission } },
        headers: asHeaders(headers),
      })
      .catch(translateRoleApiError);

    // Store description in roleAppearance if provided
    if (description !== undefined) {
      await db
        .insert(roleAppearance)
        .values({ organizationId, roleName, color: "#6B7280", description })
        .onConflictDoUpdate({
          target: [roleAppearance.organizationId, roleAppearance.roleName],
          set: { description, updatedAt: new Date() },
        });
    }

    await recordAuditEvent({
      action: "role.permissions_changed",
      entityId: roleName,
      entityType: "permission",
      after: { role: roleName, permission },
      organizationId,
    });

    return updated;
  };

  /**
   * Restores a default role's permissions to its factory baseline
   * (`DEFAULT_ROLE_PERMISSIONS`) — the counterpart to `updateRole` for the
   * one case a firm can't just delete-and-recreate: a default role must
   * always exist for `member.role` to resolve, so "undo my customizations"
   * has to be an update back to the shipped defaults, not a delete.
   */
  resetRole = async (organizationId: string, roleName: string, headers: Headers) => {
    if (!isDefaultRoleName(roleName)) {
      throw new BadRequestError(`"${roleName}" is not a default role and has no baseline to reset to`);
    }

    // Reset description to the default metadata description
    const defaultDesc = ROLE_METADATA[roleName]?.description ?? "";
    await db
      .insert(roleAppearance)
      .values({ organizationId, roleName, color: "#6B7280", description: defaultDesc })
      .onConflictDoUpdate({
        target: [roleAppearance.organizationId, roleAppearance.roleName],
        set: { description: defaultDesc, updatedAt: new Date() },
      });

    return this.updateRole(
      organizationId,
      roleName,
      DEFAULT_ROLE_PERMISSIONS[roleName] as Record<string, string[]>,
      headers,
    );
  };

  deleteRole = async (organizationId: string, roleName: string, headers: Headers) => {
    if (isLockedRole(roleName) || isDefaultRoleName(roleName)) {
      throw new AuthorizationError(
        `"${ROLE_METADATA[roleName]?.label ?? roleName}" is a default role and cannot be deleted — use "reset to default" instead`,
      );
    }

    const counts = await countMembersPerRole(organizationId);
    if ((counts[roleName] ?? 0) > 0) {
      throw new BadRequestError(
        `"${roleName}" still has ${counts[roleName]} staff member(s) assigned — reassign them before deleting the role`,
      );
    }

    await auth.api
      .deleteOrgRole({
        body: { roleName, organizationId },
        headers: asHeaders(headers),
      })
      .catch(translateRoleApiError);

    await recordAuditEvent({
      action: "role.deleted",
      entityId: roleName,
      entityType: "permission",
      organizationId,
    });

    return { message: "Role deleted" };
  };

  /**
   * Every `resource:action` string the caller's role(s) grant, flattened —
   * what the frontend's `useHasPermission` checks against, so it never has
   * to round-trip per check. Mirrors `requirePermission`'s two paths: staff
   * resolve through `member.role` + `ac`, client/contractor through the
   * static permission sets (no `organizationId` for them at all).
   */
  getMyGrants = async (userId: string, organizationId: string | null, headers: Headers) => {
    if (!organizationId) {
      const [userRecord] = await db
        .select({ accountType: user.accountType })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      const staticPermissions =
        userRecord?.accountType === "client"
          ? clientPermissions
          : userRecord?.accountType === "contractor"
            ? contractorPermissions
            : null;
      if (!staticPermissions) return [];

      const grants: string[] = [];
      for (const [resource, actions] of Object.entries(staticPermissions)) {
        for (const action of actions) grants.push(`${resource}:${action}`);
      }
      return grants;
    }

    const grants = await resolveMemberGrants(userId, organizationId, headers);
    return Array.from(grants);
  };
}
