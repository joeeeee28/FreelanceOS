import { NextResponse } from "next/server";
import { isInitialized } from "@/lib/auth/bootstrap";

/**
 * Reports live initialization state from the database, so it must not be
 * cached or prerendered at build time.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    initialized: await isInitialized(),
  });
}
