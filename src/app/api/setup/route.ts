import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { cleanText, normalizeEmail } from "@/lib/auth/normalize";
import { passwordSchema } from "@/lib/auth/password-policy";
import { hashSessionToken } from "@/lib/auth/session-hash";
import { signSessionToken } from "@/lib/auth/token";
import { sessionCookie, sessionCookieOptions } from "@/lib/auth/server";
import { CURRENCIES, normalizeCurrency } from "@/lib/money/currency";
import { normalizeTimezone } from "@/lib/time/timezone";
import { rateLimiter } from "@/lib/security/rate-limiter";
import { clientIpFromHeaders } from "@/lib/security/client-ip";
import { fieldErrorsFrom } from "@/lib/validation/field-errors";
import {
  isPrismaErrorWithCode,
  UNIQUE_CONSTRAINT_VIOLATION,
} from "@/lib/db-errors";

export const dynamic = "force-dynamic";

/**
 * Currency and timezone are validated *inside* the schema via `transform`, not
 * after parsing. Previously `normalizeCurrency`/`normalizeTimezone` were called
 * after a successful parse, so their thrown errors fell through to the generic
 * catch and produced a 500 for what is plain user input error.
 */
const schema = z.object({
  name: z.string().trim().min(2, "Enter your full name.").max(150),
  email: z.string().email("Enter a valid email address."),
  password: passwordSchema,
  workspaceName: z
    .string()
    .trim()
    .min(2, "Workspace name must contain at least 2 characters.")
    .max(200),
  defaultCurrency: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return normalizeCurrency(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Choose a supported currency (${CURRENCIES.join(", ")}).`,
        });
        return z.NEVER;
      }
    }),
  country: z.string().trim().min(2, "Enter your country.").max(100),
  timezone: z
    .string()
    .min(1, "Select a timezone.")
    .transform((value, ctx) => {
      try {
        return normalizeTimezone(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter a valid IANA timezone, for example Asia/Kolkata.",
        });
        return z.NEVER;
      }
    }),
});

export async function POST(request: Request) {
  const ip = clientIpFromHeaders(request.headers);

  if (!rateLimiter.consume(`setup:${ip}`, 5, 10 * 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  // A malformed body is a client error, not a server error.
  const body = await request.json().catch(() => null);

  if (body === null || typeof body !== "object") {
    return NextResponse.json(
      { error: "Send a JSON object." },
      { status: 400 },
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrorsFrom(parsed.error),
      },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const passwordHash = await hashPassword(input.password);
  const sessionId = randomUUID();

  try {
    // Use a batch transaction instead of an interactive transaction.
    //
    // The setup flow previously used db.$transaction(async (tx) => ...).
    // Every statement succeeded, but the interactive transaction failed while
    // committing with Prisma P2028 in the Supabase runtime. All required IDs
    // are generated up front so the dependent writes can remain atomic.
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const settingId = randomUUID();

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const rawToken = await signSessionToken({
      sessionId,
      userId,
    });

    await db.$transaction([
      db.appInit.create({
        data: { id: 1, initialized: true },
      }),
      db.workspace.create({
        data: {
          id: workspaceId,
          name: cleanText(input.workspaceName),
          defaultCurrency: input.defaultCurrency,
          country: cleanText(input.country),
          timezone: input.timezone,
        },
      }),
      db.user.create({
        data: {
          id: userId,
          workspaceId,
          name: cleanText(input.name),
          email: normalizeEmail(input.email),
          passwordHash,
          role: "OWNER",
        },
      }),
      db.setting.create({
        data: {
          id: settingId,
          workspaceId,
        },
      }),
      db.session.create({
        data: {
          id: sessionId,
          userId,
          tokenHash: hashSessionToken(rawToken),
          expiresAt,
        },
      }),
      db.appInit.update({
        where: { id: 1 },
        data: { workspaceId },
      }),
    ]);

    const jar = await cookies();
    jar.set(sessionCookie().name, rawToken, sessionCookieOptions());

    return NextResponse.json({ ok: true });
  } catch (error) {
    // Losing the AppInit(id: 1) race, or a duplicate email, is a conflict —
    // not a server fault.
    if (isPrismaErrorWithCode(error, UNIQUE_CONSTRAINT_VIOLATION)) {
      return NextResponse.json(
        { error: "Application is already initialized." },
        { status: 409 },
      );
    }

    // Unexpected failures are logged server-side without any request payload
    // (which contains the plaintext password) and reported opaquely.
    console.error("[setup] unexpected failure", {
      name: error instanceof Error ? error.name : "UnknownError",
    });

    return NextResponse.json({ error: "Setup failed." }, { status: 500 });
  }
}
