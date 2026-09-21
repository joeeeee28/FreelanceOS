import "server-only";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { verifySessionToken } from "./token";

const COOKIE_NAME = "freelanceos_session";

export function sessionCookie() {
  return { name: COOKIE_NAME };
}

export async function getSessionUser() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;

  if (!token) return null;

  try {
    const decoded = await verifySessionToken(token);

    const session = await db.session.findUnique({
      where: { id: decoded.sessionId },
      include: {
        user: {
          include: { workspace: true },
        },
      },
    });

    if (!session) return null;
    if (session.token !== token) return null;
    if (session.userId !== decoded.userId) return null;
    if (session.expiresAt <= new Date()) return null;
    if (!session.user.workspace) return null;

    return session.user;
  } catch {
    return null;
  }
}
