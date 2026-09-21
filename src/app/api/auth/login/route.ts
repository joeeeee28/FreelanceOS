import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { isInitialized } from "@/lib/auth/bootstrap";
import { normalizeEmail } from "@/lib/auth/normalize";
import { verifyPassword } from "@/lib/password";
import { randomOpaqueToken } from "@/lib/auth/session-tokens";
import { signSessionToken } from "@/lib/auth/token";
import { sessionCookie } from "@/lib/auth/server";
import { rateLimiter } from "@/lib/security/rate-limiter";

const inputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  if (!(await isInitialized())) {
    return NextResponse.json(
      { error: "Application is not initialized." },
      { status: 409 },
    );
  }

  const ip =
    request.headers
      .get("x-forwarded-for")
      ?.split(",")[0]
      ?.trim() ?? "unknown";

  if (
    !rateLimiter.consume(
      `login:${ip}`,
      20,
      10 * 60_000,
    ).ok
  ) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429 },
    );
  }

  const input = inputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!input.success) {
    return NextResponse.json(
      { error: "Invalid credentials." },
      { status: 401 },
    );
  }

  const user = await db.user.findUnique({
    where: {
      email: normalizeEmail(input.data.email),
    },
  });

  if (
    !user ||
    !(await verifyPassword(
      input.data.password,
      user.passwordHash,
    ))
  ) {
    return NextResponse.json(
      { error: "Invalid credentials." },
      { status: 401 },
    );
  }

  const temporary = randomOpaqueToken();

  const session = await db.session.create({
    data: {
      userId: user.id,
      token: temporary,
      expiresAt: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ),
    },
  });

  const token = await signSessionToken({
    sessionId: session.id,
    userId: user.id,
  });

  await db.session.update({
    where: { id: session.id },
    data: { token },
  });

  const jar = await cookies();

  jar.set(sessionCookie().name, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return NextResponse.json({ ok: true });
}
