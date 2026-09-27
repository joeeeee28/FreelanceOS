import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/server";
import { clientIpFromHeaders } from "@/lib/security/client-ip";
import { rateLimiter } from "@/lib/security/rate-limiter";

export const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Authenticated gate for the AI operator routes.
 *
 * These routes report on the local model. They are not the process liveness
 * probe, and they do not accept an endpoint, a prompt, or a model name from
 * the request — that would be an open proxy with the process's network.
 */
export async function requireAiOperator(
  request: Request,
  bucket: string,
  limit: number,
): Promise<{ userId: string } | NextResponse> {
  const ip = clientIpFromHeaders(request.headers);
  if (!rateLimiter.consume(`ai:${bucket}:ip:${ip}`, limit, 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: NO_STORE });
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: NO_STORE },
    );
  }

  if (!rateLimiter.consume(`ai:${bucket}:user:${user.id}`, limit, 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: NO_STORE });
  }

  return { userId: user.id };
}

export function isOperator(
  value: { userId: string } | NextResponse,
): value is { userId: string } {
  return !(value instanceof NextResponse);
}
