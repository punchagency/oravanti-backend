/**
 * @openapi
 * tags:
 *   - name: Settings - Role Groups
 *     description: Named bundles of roles — assign a group to staff instead of individual roles
 */
import { Router } from "express";
import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { requirePermission } from "../../../middleware/permission.middleware";
import { requireOwnerOrAdmin } from "../../../middleware/require-owner-or-admin.middleware";
import { RoleGroupsController } from "./role-groups.controller";

export class RoleGroupsRouter {
  public router: Router;
  public path: string;

  constructor(private readonly controller: RoleGroupsController) {
    this.router = Router();
    this.path = "/settings/role-groups";
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Viewing role groups only needs `ac:read` — same as the roles roster
    // and the permissions matrix.
    this.router.get("/", requirePermission("ac", "read"), this.controller.listGroups);

    // Must be registered before `/:groupId` so it isn't swallowed by that
    // param route.
    this.router.get("/memberships", requirePermission("ac", "read"), this.controller.listMemberships);

    this.router.get("/:groupId", requirePermission("ac", "read"), this.controller.getGroup);

    // Creating/editing/deleting a group is restricted to the owner and
    // admin roles directly (see `requireOwnerOrAdmin`), not to whatever
    // `ac:*` a firm grants through the permission matrix itself.
    this.router.use(requireOwnerOrAdmin());

    this.router.post("/", this.controller.createGroup);
    this.router.patch("/:groupId", this.controller.updateGroup);
    this.router.delete("/:groupId", this.controller.deleteGroup);
    this.router.post("/:groupId/members", this.controller.addMember);
    this.router.delete("/:groupId/members/:memberId", this.controller.removeMember);
  }
}
