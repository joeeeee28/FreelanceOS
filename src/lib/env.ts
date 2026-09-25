import "server-only";
import { z } from "zod";

/**
 * Required runtime configuration.
 *
 * DATABASE_URL  pooled connection used by the application at runtime
 * DIRECT_URL    direct (non-pooled) connection used by Prisma Migrate
 * AUTH_SECRET   HMAC key for session JWTs; must be >= 32 chars
 * APP_URL       absolute public origin of this deployment
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  DIRECT_URL: z.string().min(1, "DIRECT_URL is required."),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must contain at least 32 characters."),
  APP_URL: z.string().url("APP_URL must be an absolute URL."),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validates and returns the environment on first use.
 *
 * Validation is deliberately lazy rather than at module import: `next build`
 * imports server modules to collect metadata and prerender routes, and an
 * import-time `parse()` made the build fail on any machine (or CI image)
 * without production credentials. Validation is unchanged in strictness — it
 * just happens on the first actual read, so a misconfigured runtime still
 * fails immediately and loudly on the first request.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    APP_URL: process.env.APP_URL,
  });

  if (!parsed.success) {
    // Only variable names and rule descriptions are printed — never the values,
    // which hold database credentials and the signing secret.
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${details}\n` +
        "Set these variables (see .env.example) and restart the server.",
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Convenience accessor so call sites can keep reading `env.AUTH_SECRET`.
 * Each property read triggers validation on first access.
 */
export const env = new Proxy({} as Env, {
  get(_target, property: string) {
    return getEnv()[property as keyof Env];
  },
});
