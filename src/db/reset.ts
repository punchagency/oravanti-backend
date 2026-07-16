import { sql } from "drizzle-orm";
import { closeDb, db } from "./client";

async function resetDatabase() {
  try {
    console.log("Resetting public schema...");

    await db.execute(
      sql.raw(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
    `),
    );

    console.log("Database schema reset successfully");
  } catch (error) {
    console.error("Failed to reset database:", error);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

resetDatabase();
