import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { cleanText, normalizeEmail } from "@/lib/auth/normalize";
import { passwordSchema } from "@/lib/auth/password-policy";
import { signSessionToken } from "@/lib/auth/token";
import { sessionCookie } from "@/lib/auth/server";
import { normalizeCurrency } from "@/lib/money/currency";
import { normalizeTimezone } from "@/lib/time/timezone";
import { rateLimiter } from "@/lib/security/rate-limiter";

const schema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().email(),
  password: passwordSchema,
  workspaceName: z.string().trim().min(2).max(200),
  defaultCurrency: z.string().optional(),
  country: z.string().trim().min(2).max(100),
  timezone: z.string().min(1),
});

export async function POST(request: Request) {
  const ip =
    request.headers
      .get("x-forwarded-for")
      ?.split(",")[0]
      ?.trim() ?? "unknown";

  const limit = rateLimiter.consume(
    `setup:${ip}`,
    5,
    10 * 60_000,
  );

  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429 },
    );
  }

  try {
    const parsed = schema.safeParse(await request.json());

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input." },
        { status: 400 },
      );
    }

    const input = parsed.data;

    const email = normalizeEmail(input.email);
    const currency = normalizeCurrency(
      input.defaultCurrency,
    );
    const timezone = normalizeTimezone(input.timezone);
    const passwordHash = await hashPassword(
      input.password,
    );

    const result = await db.$transaction(
      async (tx) => {
        await tx.appInit.create({
          data: {
            id: 1,
            initialized: true,
          },
        });

        const workspace = await tx.workspace.create({
          data: {
            name: cleanText(input.workspaceName),
            defaultCurrency: currency,
            country: cleanText(input.country),
            timezone,
          },
        });

        const user = await tx.user.create({
          data: {
            workspaceId: workspace.id,
            name: cleanText(input.name),
            email,
            passwordHash,
            role: "OWNER",
          },
        });

        await tx.setting.create({
          data: {
            workspaceId: workspace.id,
          },
        });

        const temporaryToken =
          randomBytes(32).toString("hex");

        const session = await tx.session.create({
          data: {
            userId: user.id,
            token: temporaryToken,
            expiresAt: new Date(
              Date.now() + 30 * 24 * 60 * 60 * 1000,
            ),
          },
        });

        const jwt = await signSessionToken({
          sessionId: session.id,
          userId: user.id,
        });

        await tx.session.update({
          where: { id: session.id },
          data: { token: jwt },
        });

        await tx.appInit.update({
          where: { id: 1 },
          data: {
            workspaceId: workspace.id,
          },
        });

        return { jwt };
      },
    );

    const jar = await cookies();

    jar.set(sessionCookie().name, result.jwt, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Application is already initialized." },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: "Setup failed." },
      { status: 500 },
    );
  }
}
