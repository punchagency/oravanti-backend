/**
 * @openapi
 * tags:
 *   - name: HR - Teams
 *     description: Team management
 *
 * paths:
 *   /hr/teams/eligible-leads:
 *     get:
 *       tags: [HR - Teams]
 *       summary: Get staff eligible to be team leads
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Eligible leads list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Staff"
 *
 *   /hr/teams/:
 *     get:
 *       tags: [HR - Teams]
 *       summary: List all teams
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Teams list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Team"
 *     post:
 *       tags: [HR - Teams]
 *       summary: Create a new team
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateTeamRequest"
 *       responses:
 *         201:
 *           description: Team created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Team"
 *
 *   /hr/teams/{id}:
 *     get:
 *       tags: [HR - Teams]
 *       summary: Get team by ID
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Team data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Team"
 *         404: { description: Team not found }
 *     patch:
 *       tags: [HR - Teams]
 *       summary: Update a team
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateTeamRequest"
 *       responses:
 *         200:
 *           description: Team updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Team"
 *         404: { description: Team not found }
 *     delete:
 *       tags: [HR - Teams]
 *       summary: Delete a team
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Team deleted
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *         404: { description: Team not found }
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { TeamsController } from "./teams.controller";

export class TeamsRouter {
  public router: Router;
  public path: string;
  private teamsController: TeamsController;

  constructor(teamsController: TeamsController) {
    this.router = Router();
    this.path = "/hr/teams";
    this.teamsController = teamsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/eligible-leads", this.teamsController.getEligibleLeads);
    this.router.get("/", this.teamsController.getAll);
    this.router.get("/:id", this.teamsController.getById);
    this.router.post("/", this.teamsController.createTeam);
    this.router.patch("/:id", this.teamsController.updateTeam);
    this.router.delete("/:id", this.teamsController.deleteTeam);
  }
}
