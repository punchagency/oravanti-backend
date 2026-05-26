import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import "dotenv/config";
import express from "express";
import morgan from "morgan";
import { auth } from "./auth";
import aiErrorDetectionRoutes from "./resources/ai-error-detection/ai-error-detection.routes";
import authRoutes from "./resources/auth/auth.routes";
import calendarRoutes from "./resources/calendar/calendar.routes";
import casesRoutes from "./resources/cases/cases.routes";
import clientResponsivenessRoutes from "./resources/client-responsiveness/client-responsiveness.routes";
import clientsRoutes from "./resources/clients/clients.routes";
import documentsRoutes from "./resources/documents/documents.routes";
import assignmentsRoutes from "./resources/hr-management/assignments/assignments.routes";
import staffRoutes from "./resources/hr-management/staffs/staffs.routes";
import teamsRoutes from "./resources/hr-management/teams/teams.routes";
import revenueAnalyticsRoutes from "./resources/revenue-analytics/revenue-analytics.routes";
import accessControlRoutes from "./resources/settings/access-control/access-control.routes";
import approvalWorkflowsRoutes from "./resources/settings/approval-workflows/approval-workflows.routes";
import dataAccessRoutes from "./resources/settings/data-access/data-access.routes";
import financialAccessRoutes from "./resources/settings/financial-access/financial-access.routes";
import firmInfoRoutes from "./resources/settings/firm-info/firm-info.routes";
import permissionAuditLogRoutes from "./resources/settings/permission-audit-log/permission-audit-log.routes";
import profileRoutes from "./resources/settings/profile/profile.routes";
import securityRoutes from "./resources/settings/security/security.routes";
import tasksRoutes from "./resources/tasks/tasks.routes";

const app = express();
const PORT = process.env.PORT || 8001;
const allowedOrigins = process.env.CORS_ORIGIN;

const origin = (
  requestOrigin: string | undefined,
  callback: (
    err: Error | null,
    origin?: boolean | string | RegExp | Array<boolean | string | RegExp>,
  ) => void,
) => {
  if (!requestOrigin || requestOrigin === "null") {
    return callback(null, true);
  }

  if (!allowedOrigins) {
    return callback(new Error("Not allowed by CORS"));
  }

  const origins = allowedOrigins.split(",").map((origin) => origin.trim());

  if (origins.includes(requestOrigin as string) || origins.includes("*")) {
    callback(null, true);
  } else {
    callback(new Error("Not allowed by CORS"));
  }
};

const corsOptions = {
  origin,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(morgan("dev"));
app.use(express.json());

/**
 * Better Auth's toNodeHandler is used to wrap the auth instance and handle all requests to /api/auth/* routes.
 * This allows Better Auth to manage authentication and session handling for these routes.
 * The authRoutes are also mounted on /api/auth to handle any additional authentication-related endpoints.
 */
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use("/api/auth", authRoutes);
app.all("/api/auth/*splat", toNodeHandler(auth));
app.use("/api/hr/staff", staffRoutes);
app.use("/api/hr/teams", teamsRoutes);
app.use("/api/hr/assignments", assignmentsRoutes);
app.use("/api/settings/profile", profileRoutes);
app.use("/api/settings/firm-info", firmInfoRoutes);
app.use("/api/settings/access-control", accessControlRoutes);
app.use("/api/settings/financial-access", financialAccessRoutes);
app.use("/api/settings/approval-workflows", approvalWorkflowsRoutes);
app.use("/api/settings/permission-audit-log", permissionAuditLogRoutes);
app.use("/api/settings/data-access", dataAccessRoutes);
app.use("/api/settings/security", securityRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/cases", casesRoutes);
app.use("/api/tasks", tasksRoutes);
app.use("/api/client-responsiveness", clientResponsivenessRoutes);
app.use("/api/revenue-analytics", revenueAnalyticsRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/ai-error-detection", aiErrorDetectionRoutes);
app.use("/api/calendar", calendarRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
