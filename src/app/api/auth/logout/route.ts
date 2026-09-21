import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionCookie, sessionCookieOptions } from "@/lib/auth/server";
import { hashSessionToken } from "@/lib/auth/session-hash";

export const dynamic = "force-dynamic";

export async function POST() {
  const jar = await cookies();
  const name = sessionCookie().name;
  const token = jar.get(name)?.value;

  if (token) {
    // Look the row up by digest — the raw token is not stored anywhere.
    // deleteMany (not delete) so an already-removed session is not an error.
    await db.session.deleteMany({
      where: { tokenHash: hashSessionToken(token) },
    });
  }

  // Clear the cookie regardless, so a stale or unparseable cookie cannot get
  // stuck in the browser.
  jar.set(name, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });

  return NextResponse.json({ ok: true });
}
