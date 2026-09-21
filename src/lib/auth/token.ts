import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";

let cachedSecret: Uint8Array | null = null;

/**
 * Resolved on first use rather than at module load.
 *
 * `next build` imports this module while collecting route metadata, and a
 * top-level read of `env.AUTH_SECRET` made the build fail on any machine
 * without production credentials. Runtime behaviour is unchanged: the first
 * sign/verify still fails loudly if AUTH_SECRET is missing or too short.
 */
function getSecret(): Uint8Array {
  cachedSecret ??= new TextEncoder().encode(env.AUTH_SECRET);
  return cachedSecret;
}

export async function signSessionToken(input: {
  sessionId: string;
  userId: string;
}) {
  return new SignJWT(input)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

export async function verifySessionToken(token: string) {
  const result = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });

  if (
    typeof result.payload.sessionId !== "string" ||
    typeof result.payload.userId !== "string"
  ) {
    throw new Error("Invalid session");
  }

  return {
    sessionId: result.payload.sessionId,
    userId: result.payload.userId,
  };
}
