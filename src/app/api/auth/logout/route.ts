import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionCookie } from "@/lib/auth/server";

export async function POST() {
  const jar = await cookies();
  const name = sessionCookie().name;
  const token = jar.get(name)?.value;

  if (token) {
    await db.session.deleteMany({
      where: { token },
    });
  }

  jar.set(name, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({ ok: true });
}
