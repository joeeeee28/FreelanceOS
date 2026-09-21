import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";

const secret = new TextEncoder().encode(env.AUTH_SECRET);

export async function signSessionToken(input: {
  sessionId: string;
  userId: string;
}) {
  return new SignJWT(input)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
}

export async function verifySessionToken(token: string) {
  const result = await jwtVerify(token, secret);

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
