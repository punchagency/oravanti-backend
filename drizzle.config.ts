import { defineConfig } from "drizzle-kit";
import { env } from "./src/config/env";

export default defineConfig({
  schema: "./src/db/schema",
  dialect: "postgresql",
  out: "./src/db/migrations",
  dbCredentials: {
    url: env.databaseUrl,
  },
});
