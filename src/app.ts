import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express, { Application, Request, Response, Router } from "express";
import morgan from "morgan";
import { auth } from "./auth";

import { errorMiddleware } from "./middleware/error.middleware";
import { notFoundMiddleware } from "./middleware/notFound.middleware";

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

    this.express.use(morgan("dev"));
    this.express.use(cors(corsOptions));
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
    })

    this.express.get("/api", (_req: Request, res: Response) => {
      res.redirect("/");
    });

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

  public listen() {
    this.express.listen(this.port, () => {
      console.log(`app listening on port ${this.port}`);
    });
  }
}
