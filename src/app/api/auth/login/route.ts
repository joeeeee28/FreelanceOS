import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { isInitialized } from "@/lib/auth/bootstrap";
import { normalizeEmail } from "@/lib/auth/normalize";
import { verifyPassword } from "@/lib/password";
import { issueSession } from "@/lib/auth/session";
import { sessionCookie, sessionCookieOptions } from "@/lib/auth/server";
import { rateLimiter } from "@/lib/security/rate-limiter";
import { clientIpFromHeaders } from "@/lib/security/client-ip";

export const dynamic = "force-dynamic";

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

  const ip = clientIpFromHeaders(request.headers);

  if (!rateLimiter.consume(`login:ip:${ip}`, 20, 10 * 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const input = inputSchema.safeParse(await request.json().catch(() => null));

  if (!input.success) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const email = normalizeEmail(input.data.email);

  // Per-account throttling in addition to per-IP, so a distributed attacker
  // cannot brute force one account by rotating source addresses.
  if (!rateLimiter.consume(`login:email:${email}`, 10, 10 * 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const user = await db.user.findUnique({ where: { email } });

  // Always run a bcrypt comparison, even when the account does not exist, so
  // response timing does not reveal whether an email is registered.
  const passwordMatches = await verifyPassword(
    input.data.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !passwordMatches) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const { rawToken } = await issueSession(db, {
    userId: user.id,
    sessionId: randomUUID(),
  });

  const jar = await cookies();
  jar.set(sessionCookie().name, rawToken, sessionCookieOptions());

  return NextResponse.json({ ok: true });
}

/**
 * A real bcrypt hash (cost 12) of a value no user can hold, used purely to
 * equalise timing for unknown accounts. This is not a credential: nothing
 * authenticates against it, because the `!user` check rejects first.
 */
const DUMMY_PASSWORD_HASH =
  "$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
