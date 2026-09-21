import "server-only";
import { db } from "@/lib/db";

export async function isInitialized() {
  const init = await db.appInit.findUnique({
    where: { id: 1 },
  });

  return init?.initialized === true && init.workspaceId !== null;
}
