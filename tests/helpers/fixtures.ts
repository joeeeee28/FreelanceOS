import { randomUUID } from "node:crypto";

import { hashSessionToken } from "@/lib/auth/session-hash";
import { signSessionToken } from "@/lib/auth/token";
import { db } from "./test-prisma";

export interface SeededWorkspace {
  workspaceId: string;
  userId: string;
  email: string;
  rawToken: string;
  sessionId: string;
}

/**
 * Creates an isolated workspace with one owner and a live session.
 *
 * Only structural records are created — no demo leads, revenue or sample
 * business data. Tests that need a lead create exactly the record they assert
 * on.
 */
export async function seedWorkspace(
  label: string,
  options: { expiresAt?: Date } = {},
): Promise<SeededWorkspace> {
  const workspace = await db.workspace.create({
    data: {
      name: `${label} Workspace`,
      defaultCurrency: "INR",
      country: "India",
      timezone: "Asia/Kolkata",
    },
  });

  const email = `${label.toLowerCase()}-${randomUUID()}@example.test`;

  const user = await db.user.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Owner`,
      email,
      // A bcrypt-shaped placeholder: these tests never exercise password login.
      passwordHash: "$2a$12$0000000000000000000000000000000000000000000000000000",
      role: "OWNER",
    },
  });

  const sessionId = randomUUID();

  const rawToken = await signSessionToken({
    sessionId,
    userId: user.id,
  });

  await db.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });

  return {
    workspaceId: workspace.id,
    userId: user.id,
    email,
    rawToken,
    sessionId,
  };
}
