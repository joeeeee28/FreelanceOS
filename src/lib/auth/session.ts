import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";

import { signSessionToken } from "./token";
import { hashSessionToken } from "./session-hash";

/**
 * Sessions last 30 days. Kept here so the cookie `maxAge`, the JWT expiry and
 * the database `expiresAt` cannot drift apart.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

type PrismaLike = PrismaClient | Prisma.TransactionClient;

/**
 * Creates a session row and returns the raw bearer token for the cookie.
 *
 * The database only ever receives the SHA-256 digest of the token. The raw
 * value is returned to the caller and must never be logged or persisted.
 *
 * The session id is generated up front so the JWT can embed it without the
 * insert-then-update round trip the previous implementation used (which also
 * briefly stored a throwaway token and was not transactional on the login
 * path).
 */
export async function issueSession(
  client: PrismaLike,
  params: { userId: string; sessionId: string },
): Promise<{ rawToken: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  const rawToken = await signSessionToken({
    sessionId: params.sessionId,
    userId: params.userId,
  });

  await client.session.create({
    data: {
      id: params.sessionId,
      userId: params.userId,
      tokenHash: hashSessionToken(rawToken),
      expiresAt,
    },
  });

  return { rawToken, expiresAt };
}
