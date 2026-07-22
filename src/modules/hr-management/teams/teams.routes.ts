/**
 * @openapi
 * tags:
 *   - name: HR - Teams
 *     description: Team management
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { CommonValidation } from "../../../validation/common.validation";

import { validateRequest } from "../../../middleware/validate.middleware";
import { TeamsController } from "./teams.controller";

export class TeamsRouter {
  public router: Router;
  public path: string;
  private teamsController: TeamsController;
  private validation: CommonValidation;

  constructor(teamsController: TeamsController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/hr/teams";
    this.teamsController = teamsController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /hr/teams/eligible-leads:
     *   get:
     *     tags: [HR - Teams]
     *     summary: Get staff eligible to be team leads
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Eligible leads list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/Staff"
     */
    this.router.get("/eligible-leads", this.teamsController.getEligibleLeads);

    /**
     * @openapi
     * /hr/teams/:
     *   get:
     *     tags: [HR - Teams]
     *     summary: List all teams
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Teams list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/Team"
     */
    this.router.get("/", this.teamsController.getAll);

    /**
     * @openapi
     * /hr/teams/{id}:
     *   get:
     *     tags: [HR - Teams]
     *     summary: Get team by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Team data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Team"
     *       404: { description: Team not found }
     */
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.teamsController.getById,
    );

    /**
     * @openapi
     * /hr/teams/:
     *   post:
     *     tags: [HR - Teams]
     *     summary: Create a new team
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CreateTeamRequest"
     *     responses:
     *       201:
     *         description: Team created
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Team"
     */
    this.router.post(
      "/",
      validateRequest({ body: this.validation.requiredBody("name") }),
      this.teamsController.createTeam,
    );

    /**
     * @openapi
     * /hr/teams/{id}:
     *   patch:
     *     tags: [HR - Teams]
     *     summary: Update a team
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateTeamRequest"
     *     responses:
     *       200:
     *         description: Team updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Team"
     *       404: { description: Team not found }
     */
    this.router.patch(
      "/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.teamsController.updateTeam,
    );

    /**
     * @openapi
     * /hr/teams/{id}:
     *   delete:
     *     tags: [HR - Teams]
     *     summary: Delete a team
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Team deleted
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Team not found }
     */
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.teamsController.deleteTeam,
    );
  }
}
