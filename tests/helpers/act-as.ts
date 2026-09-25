import { db } from "./test-prisma";
import type { SeededWorkspace } from "./fixtures";

export interface CurrentUserState {
  value: null | { userId: string; workspaceId: string };
}

/**
 * Builds the `requireUser()` replacement used by CRM service tests.
 *
 * Only the identity boundary is mocked. Everything below it — validation,
 * Prisma queries, transactions, activity writes — runs for real against the
 * disposable Postgres, so workspace scoping is genuinely exercised rather
 * than stubbed out.
 *
 * `vi.mock` must still be called at the top level of each test file (Vitest
 * hoists it per file); this helper supplies the factory body:
 *
 *   const currentUser = vi.hoisted(() => ({ value: null }));
 *   vi.mock("@/lib/auth/require-user", () => requireUserMock(currentUser));
 */
export function requireUserMock(state: CurrentUserState) {
  return {
    requireUser: async () => {
      if (!state.value) throw new Error("NOT_AUTHENTICATED");

      const workspace = await db.workspace.findUniqueOrThrow({
        where: { id: state.value.workspaceId },
      });

      return {
        user: { id: state.value.userId, workspaceId: workspace.id },
        userId: state.value.userId,
        workspaceId: workspace.id,
        workspace,
      };
    },
  };
}

/** Switches the mocked session to the given seeded workspace owner. */
export function actAsFactory(state: CurrentUserState) {
  return (session: SeededWorkspace) => {
    state.value = { userId: session.userId, workspaceId: session.workspaceId };
  };
}
