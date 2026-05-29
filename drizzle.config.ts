import { defineConfig } from "drizzle-kit";
import { env } from "./src/config/env";

export default defineConfig({
  schema: "./src/db/schema",
  dialect: "postgresql",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: env.databaseUrl,
  },
});
