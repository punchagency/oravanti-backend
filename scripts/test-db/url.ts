import "dotenv/config";

/**
 * Resolves the connection URLs used by the test-database tooling.
 *
 * The test database is addressed by `TEST_DATABASE_URL`. As a convenience,
 * `TEST_DATABASE_NAME` is also accepted: the name is swapped into the regular
 * `DATABASE_URL` so credentials/host only have to be configured once.
 *
 * Every consumer of this module creates, drops or truncates whole databases, so
 * the guards below are load-bearing rather than defensive noise.
 */
export type TestDbTarget = {
  /** Connection URL for the test database itself. */
  testUrl: string;
  /** Connection URL for the `postgres` maintenance DB (CREATE/DROP DATABASE). */
  adminUrl: string;
  /** Bare database name, e.g. `oravanti_test_db`. */
  dbName: string;
};

const dbNameOf = (url: URL) => decodeURIComponent(url.pathname.replace(/^\//, ""));

export const resolveTestDbTarget = (): TestDbTarget => {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run test-database tooling with NODE_ENV=production",
    );
  }

  const primary = process.env.DATABASE_URL?.trim();
  if (!primary) {
    throw new Error("DATABASE_URL is not set");
  }

  const explicit = process.env.TEST_DATABASE_URL?.trim();
  const name = process.env.TEST_DATABASE_NAME?.trim();

  let testUrl: URL;
  if (explicit) {
    testUrl = new URL(explicit);
  } else if (name) {
    testUrl = new URL(primary);
    testUrl.pathname = `/${name}`;
  } else {
    throw new Error(
      "Set TEST_DATABASE_URL (or TEST_DATABASE_NAME) to the database used for checks",
    );
  }

  const dbName = dbNameOf(testUrl);
  if (!dbName) {
    throw new Error("Test database URL has no database name in its path");
  }

  // The whole point of a separate test DB is that setup/drop can be destructive.
  // If it resolves to the development database, that guarantee is gone.
  const primaryUrl = new URL(primary);
  if (
    dbName === dbNameOf(primaryUrl) &&
    testUrl.host === primaryUrl.host
  ) {
    throw new Error(
      `Test database (${dbName}) resolves to the same database as DATABASE_URL — refusing to continue`,
    );
  }

  const adminUrl = new URL(testUrl.toString());
  adminUrl.pathname = "/postgres";

  return { testUrl: testUrl.toString(), adminUrl: adminUrl.toString(), dbName };
};

/** `postgresql://user:***@host/db` — safe to print. */
export const maskUrl = (url: string) =>
  url.replace(/(:\/\/[^:/]+:)[^@]*@/, "$1***@");
