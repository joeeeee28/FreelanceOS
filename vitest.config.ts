import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // NOTE: order matters. Vite matches aliases in order, so the specific
    // "@/lib/db" entry must be declared before the generic "@" prefix,
    // otherwise "@" wins and the real (binary-engine) client gets loaded.
    alias: [
      {
        // Application data-access code imports `@/lib/db`. In tests that same
        // code must run against the disposable test database via the driver
        // adapter, so the module is swapped here rather than in the source.
        find: /^@\/lib\/db$/,
        replacement: fileURLToPath(
          new URL("./tests/helpers/test-prisma.ts", import.meta.url),
        ),
      },
      {
        // `server-only` throws on import outside a React Server Component
        // runtime. Next.js swaps it for an empty module via the "react-server"
        // export condition; the test runner does the same so server modules
        // can be imported directly. This does not weaken the app build guard.
        find: /^server-only$/,
        replacement: fileURLToPath(
          new URL("./node_modules/server-only/empty.js", import.meta.url),
        ),
      },
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("./src/", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Integration tests share one disposable Postgres database, so they must
    // not run concurrently against each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
