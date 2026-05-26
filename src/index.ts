import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import { env } from "./config/env";
import { auth } from "./auth";
import aiErrorDetectionRoutes from "./routes/ai-error-detection/ai-error-detection.routes";
import authRoutes from "./routes/auth.routes";
import calendarRoutes from "./routes/calendar/calendar.routes";
import casesRoutes from "./routes/cases/cases.routes";
import clientResponsivenessRoutes from "./routes/client-responsiveness/client-responsiveness.routes";
import clientsRoutes from "./routes/clients/clients.routes";
import documentsRoutes from "./routes/documents/documents.routes";
import assignmentsRoutes from "./routes/hr/assignments.routes";
import staffRoutes from "./routes/hr/staff.routes";
import teamsRoutes from "./routes/hr/teams.routes";
import revenueAnalyticsRoutes from "./routes/revenue-analytics/revenue-analytics.routes";
import accessControlRoutes from "./routes/settings/access-control.routes";
import approvalWorkflowsRoutes from "./routes/settings/approval-workflows.routes";
import dataAccessRoutes from "./routes/settings/data-access.routes";
import financialAccessRoutes from "./routes/settings/financial-access.routes";
import firmInfoRoutes from "./routes/settings/firm-info.routes";
import permissionAuditLogRoutes from "./routes/settings/permission-audit-log.routes";
import profileRoutes from "./routes/settings/profile.routes";
import securityRoutes from "./routes/settings/security.routes";
import tasksRoutes from "./routes/tasks/tasks.routes";
import { AuthorizationError, NotFoundError } from "./errors/app-error";
import { errorHandler } from "./middleware/error.middleware";

const app = express();
const PORT = env.PORT;
const allowedOrigins = env.CORS_ORIGIN;

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
    return callback(new AuthorizationError("Not allowed by CORS"));
  }

  const origins = allowedOrigins.split(",").map((origin) => origin.trim());

  if (origins.includes(requestOrigin as string) || origins.includes("*")) {
    callback(null, true);
  } else {
    callback(new AuthorizationError("Not allowed by CORS"));
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

app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError("Route not found"));
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
