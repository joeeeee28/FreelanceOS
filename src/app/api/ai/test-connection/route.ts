import { NextResponse } from "next/server";

import { testAiConnection, toPublicAiHealth } from "@/lib/ai/health";

import { isOperator, NO_STORE, requireAiOperator } from "../guard";

export const dynamic = "force-dynamic";

/**
 * Explicit connection test.
 *
 * The body is ignored. An endpoint, model, or prompt in the body would let an
 * authenticated caller aim this process at an arbitrary host, or use the
 * local model as an open generator. Configuration comes from the environment.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 2048) {
    return NextResponse.json({ error: "Request too large." }, { status: 413, headers: NO_STORE });
  }

  const operator = await requireAiOperator(request, "test", 6);
  if (!isOperator(operator)) return operator;

  const report = await testAiConnection();
  return NextResponse.json(toPublicAiHealth(report), { headers: NO_STORE });
}
