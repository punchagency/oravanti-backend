import { toNodeHandler } from "better-auth/node";
import compression from "compression";
import cors from "cors";
import { sql } from "drizzle-orm";
import express, { Application, Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import type { Server } from "node:http";
import swaggerUi from "swagger-ui-express";
import { auth } from "./auth";
import { db } from "./db/client";
import { env } from "./config/env";

import { errorMiddleware } from "./middleware/error.middleware";
import { notFoundMiddleware } from "./middleware/notFound.middleware";
import { requestContextMiddleware } from "./middleware/request-context";
import { swaggerSpec } from "./swagger";

export interface Module {
  router: Router;
  path: string;
}

/**
 * A fixed-window limiter keyed on client IP.
 *
 * `standardHeaders` emits RateLimit-* so clients can back off deliberately;
 * the legacy X-RateLimit-* headers are dropped. The handler throws through the
 * normal error pipeline so the 429 carries the same envelope as every other
 * error response.
 */
const makeRateLimit = (limit: number, windowMs = 60_000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      success: false,
      code: "RATE_LIMITED",
      message: "Too many requests. Please wait a moment and try again.",
    },
  });

export class App {
  public express: Application;
  private modules: Module[];
  private port: number;

  constructor(modules: Module[], port: number) {
    this.express = express();
    this.port = port;
    this.modules = modules;

    this.initiatializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private initiatializeMiddlewares() {
    // Rate limiting and the request-context IP both read the client address
    // through the proxy. Trust exactly one hop — `true` would let a client
    // spoof its own address via X-Forwarded-For and defeat both.
    this.express.set("trust proxy", 1);
    this.express.disable("x-powered-by");

    // Content-Security-Policy is switched off globally because every response
    // this app produces is JSON, where CSP does nothing. The one HTML surface
    // (/api-docs) gets its own policy at the point it is mounted.
    this.express.use(
      helmet({
        contentSecurityPolicy: false,
        // The SPA lives on a different origin, so resources served from here
        // must remain loadable cross-origin.
        crossOriginResourcePolicy: { policy: "cross-origin" },
      }),
    );

    this.express.use(morgan("dev"));

    // Several read endpoints return large JSON trees (the practice-area
    // taxonomy alone is ~140 KB uncompressed); gzip takes those to a tenth of
    // the size. Mounted before the auth handler so every response benefits.
    this.express.use(compression());

    const allowedOrigins = env.CORS_ORIGIN;
    const betterAuthUrl = env.BETTER_AUTH_URL;

    const makeCorsOrigin =
      (serverOrigin: string) =>
      (
        requestOrigin: string | undefined,
        callback: (
          err: Error | null,
          origin?: boolean | string | RegExp | Array<boolean | string | RegExp>,
        ) => void,
      ) => {
        if (!requestOrigin || requestOrigin === "null") {
          return callback(null, true);
        }

        const origins: string[] = [serverOrigin];

        if (allowedOrigins) {
          origins.push(...allowedOrigins.split(",").map((o) => o.trim()));
        }

        if (betterAuthUrl) {
          origins.push(betterAuthUrl);
        }

        if (origins.includes(requestOrigin) || origins.includes("*")) {
          return callback(null, true);
        }

        callback(new Error("Not allowed by CORS"));
      };

    this.express.use(
      (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        const serverOrigin = `${req.protocol}://${req.get("host")}`;
        cors({
          origin: makeCorsOrigin(serverOrigin),
          methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
          credentials: true,
        })(req, res, next);
      },
    );
    /**
     * Credential endpoints are the ones worth brute-forcing: password sign-in,
     * email OTP, and 2FA verification all live under /api/auth. The limiter is
     * mounted before the handler so a refused request never reaches Better
     * Auth — and never costs a database round trip.
     */
    this.express.use("/api/auth", makeRateLimit(10));

    /**
     * The payment link's token IS the credential and the route is
     * unauthenticated, so an unthrottled endpoint is a token oracle.
     */
    this.express.use("/invoice-payment", makeRateLimit(30));

    /**
     * Better Auth Initialization
     */
    this.express.all("/api/auth/*splat", toNodeHandler(auth));
    /**
     * Payment webhooks need the RAW body, and must be mounted before the JSON
     * parser to get it.
     *
     * Every payment provider signs the exact bytes it sent. Once
     * `express.json()` has parsed and discarded them, re-serialising the object
     * will not reproduce the original — key order and whitespace both differ —
     * so signature verification fails on legitimate events. The Dropbox Sign
     * webhook avoids this only because it receives multipart and uses multer.
     */
    this.express.use(
      "/webhooks/payments",
      express.raw({ type: "application/json" }),
    );
    // Explicit ceiling. Express defaults to 100kb, but the default is not a
    // decision — anything larger than this belongs on an upload route, where
    // middleware/upload.ts applies a per-file limit instead.
    this.express.use(express.json({ limit: "1mb" }));
    this.express.use(requestContextMiddleware);
  }

  private initializeRoutes() {
    this.express.get("/", (_req: Request, res: Response) => {
      res.json({
        message: "welcome to Oravanti API",
      });
    });

    // A health check that does not touch its dependencies reports healthy while
    // Postgres is unreachable, which is exactly when the load balancer needs to
    // know otherwise.
    this.express.get("/health", async (_req: Request, res: Response) => {
      try {
        await db.execute(sql`SELECT 1`);
        res.json({ status: "ok", database: "ok" });
      } catch (error) {
        console.error("[health] database check failed", error);
        res.status(503).json({ status: "degraded", database: "unreachable" });
      }
    });

    // Separate liveness probe: "the process is running", no dependencies. Use
    // this one for restart decisions, /health for traffic decisions.
    this.express.get("/health/live", (_req: Request, res: Response) => {
      res.json({ status: "ok" });
    });

    this.express.get("/api", (_req: Request, res: Response) => {
      res.redirect("/");
    });

    this.express.use(
      "/api-docs",
      // The only HTML this app serves, and the only place CSP is meaningful.
      // Swagger UI needs inline script and style to boot.
      helmet.contentSecurityPolicy({
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
        },
      }),
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        customSiteTitle: "Oravanti API Docs",
        swaggerOptions: {
          filter: true,
          displayRequestDuration: true,
        },
      }),
    );

    this.modules.forEach((module: Module) => {
      this.express.use(module.path, module.router);
    });
  }

  private initializeErrorHandling(): void {
    // catch 404 and forward to error handler
    this.express.use(notFoundMiddleware);

    // error handler
    this.express.use(errorMiddleware);
  }

  public async testDbConnection() {
    await db.execute(sql`SELECT 1`);
    console.log("database connection verified");
  }

  public async listen(): Promise<Server> {
    await this.testDbConnection();

    return this.express.listen(this.port, () => {
      console.log(`app listening on port ${this.port}`);
    });
  }
}
