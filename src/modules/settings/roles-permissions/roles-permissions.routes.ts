/**
 * @openapi
 * tags:
 *   - name: Settings - Roles & Permissions
 *     description: Dynamic role management — default roster, firm-defined custom roles, and the permissions matrix
 */
import { Router } from "express";
import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { requirePermission } from "../../../middleware/permission.middleware";
import { requireOwnerOrAdmin } from "../../../middleware/require-owner-or-admin.middleware";
import { RolesPermissionsController } from "./roles-permissions.controller";

export class RolesPermissionsRouter {
  public router: Router;
  public path: string;

  constructor(private readonly controller: RolesPermissionsController) {
    this.router = Router();
    this.path = "/settings/roles-permissions";
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Every authenticated user (staff, client, contractor) can read their
    // own resolved grants — that's what the frontend's useHasPermission is
    // backed by. No `ac` permission required; you always know what you can do.
    this.router.get("/my-grants", this.controller.getMyGrants);

    // Lightweight name+label list for role-assignment dropdowns outside the
    // RBAC admin page (invite staff, edit staff) — gated on `staffs:read`,
    // not restricted to owner/admin, since any staff who can invite/edit
    // colleagues needs it. Everything else below is the RBAC page itself.
    this.router.get(
      "/role-options",
      requirePermission("staffs", "read"),
      this.controller.getRoleOptions,
    );

    // Viewing the RBAC page (roster + matrix) only needs `ac:read` — a
    // firm can grant a custom role visibility here the same way it grants
    // any other resource's `read` action.
    this.router.get("/roles", requirePermission("ac", "read"), this.controller.getRoles);
    this.router.get("/matrix", requirePermission("ac", "read"), this.controller.getMatrix);

    // Creating/editing/deleting a role, however, is restricted to the owner
    // and admin roles directly (see `requireOwnerOrAdmin`), not to whatever
    // `ac:*` a firm grants through the permission matrix itself — otherwise
    // a firm could hand a custom role the ability to grant itself more.
    this.router.use(requireOwnerOrAdmin());

    this.router.post("/roles", this.controller.createRole);
    this.router.patch("/roles/:roleName", this.controller.updateRole);
    this.router.delete("/roles/:roleName", this.controller.deleteRole);

    // Restores a default role's permissions to its factory baseline —
    // distinct from delete, since a default role must always exist.
    this.router.post("/roles/:roleName/reset", this.controller.resetRole);

    // Cosmetic only (a role's accent color).
    this.router.patch("/roles/:roleName/color", this.controller.setRoleColor);
  }
}
