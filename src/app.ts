import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import { sql } from "drizzle-orm";
import express, { Application, Request, Response, Router } from "express";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import { auth } from "./auth";
import { db } from "./db/client";

import { errorMiddleware } from "./middleware/error.middleware";
import { notFoundMiddleware } from "./middleware/notFound.middleware";
import { swaggerSpec } from "./swagger";

export interface RouterEntry {
  router: Router;
  path: string;
}

export class App {
  public express: Application;
  private routers: RouterEntry[];
  private port: number;

  constructor(routers: RouterEntry[], port: number) {
    this.express = express();
    this.port = port;
    this.routers = routers;

    this.initiatializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private initiatializeMiddlewares() {
    const allowedOrigins = process.env.CORS_ORIGIN;
    const betterAuthUrl = process.env.BETTER_AUTH_URL;

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
     * Better Auth Initialization
     */
    this.express.all("/api/auth/*splat", toNodeHandler(auth));
    this.express.use(express.json());
  }

  private initializeRoutes() {
    this.express.get("/", (_req: Request, res: Response) => {
      res.json({
        message: "welcome to Oravanti API",
      });
    });

    this.express.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "Oravanti API up and running",
      });
    });

    this.express.get("/api", (_req: Request, res: Response) => {
      res.redirect("/");
    });

    this.express.use(
      "/api-docs",
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        customSiteTitle: "Oravanti API Docs",
        swaggerOptions: {
          filter: true,
          displayRequestDuration: true,
        },
      }),
    );

    this.routers.forEach((entry: RouterEntry) => {
      this.express.use(entry.path, entry.router);
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

  public async listen() {
    await this.testDbConnection();

    this.express.listen(this.port, () => {
      console.log(`app listening on port ${this.port}`);
    });
  }
}
