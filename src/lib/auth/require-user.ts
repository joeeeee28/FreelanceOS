import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser } from "./server";

export async function requireUser() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  return {
    user,
    userId: user.id,
    workspaceId: user.workspaceId,
    workspace: user.workspace,
  };
}
