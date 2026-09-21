import { TEST_DATABASE_URL } from "./helpers/test-db";

/**
 * Test-only configuration. These are throwaway values for a disposable local
 * database — never real credentials, and never written to a .env file.
 */
// NODE_ENV is set to "test" by Vitest itself.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-only-auth-secret-value-not-for-production-use";
process.env.APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";
