import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const DB_URL =
  process.env.NODE_ENV === "development"
    ? process.env.DATABASE_URL
    : process.env.PROD_DATABASE_URL;

export default defineConfig({
  schema: "./src/db/schema",
  dialect: "postgresql",
  out: "./src/db/migrations",
  dbCredentials: {
    url: DB_URL as string,
  },
});
