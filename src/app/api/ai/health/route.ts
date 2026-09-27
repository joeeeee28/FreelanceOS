import { NextResponse } from "next/server";

import { getAiHealth, toPublicAiHealth } from "@/lib/ai/health";

import { isOperator, NO_STORE, requireAiOperator } from "../guard";

export const dynamic = "force-dynamic";

/**
 * Live AI health for a signed-in operator.
 *
 * This is not a liveness probe. `/api/health` stays independent of Ollama so
 * a stopped model cannot fail the process. The body never includes the raw
 * endpoint URL. The request cannot choose a different host.
 */
export async function GET(request: Request) {
  const operator = await requireAiOperator(request, "health", 30);
  if (!isOperator(operator)) return operator;

  const report = await getAiHealth();
  return NextResponse.json(toPublicAiHealth(report), { headers: NO_STORE });
}
