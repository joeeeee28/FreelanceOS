import "server-only";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { verifySessionToken } from "./token";
import { hashSessionToken, sessionTokenDigestsMatch } from "./session-hash";
import { SESSION_TTL_SECONDS } from "./session";

const COOKIE_NAME = "freelanceos_session";

export function sessionCookie() {
  return { name: COOKIE_NAME };
}

/**
 * Cookie attributes shared by every place that sets the session cookie, so
 * login, setup and logout cannot drift apart.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function getSessionUser() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;

  if (!token) return null;

  try {
    // 1. The JWT signature must verify. This alone is not sufficient: a signed
    //    token whose session row was deleted (logout) must not authenticate.
    const decoded = await verifySessionToken(token);

    // 2. The session is looked up by the digest of the presented token, so the
    //    raw bearer value never has to exist in the database.
    const presentedHash = hashSessionToken(token);

    const session = await db.session.findUnique({
      where: { id: decoded.sessionId },
      include: {
        user: {
          include: { workspace: true },
        },
      },
    });

    if (!session) return null;
    if (!sessionTokenDigestsMatch(session.tokenHash, presentedHash)) return null;
    if (session.userId !== decoded.userId) return null;
    if (session.expiresAt <= new Date()) return null;
    if (!session.user.workspace) return null;

    return session.user;
  } catch {
    // Invalid/expired/tampered JWTs are simply "not authenticated". The
    // underlying error is intentionally not surfaced or logged, so token
    // material never reaches the logs.
    return null;
  }
}
