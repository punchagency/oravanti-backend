import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";

const client = postgres(env.databaseUrl);
export const db = drizzle(client, {
  logger: false,
  // logger: env.NODE_ENV === "development",
});
