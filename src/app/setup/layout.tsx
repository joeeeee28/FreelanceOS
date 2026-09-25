import { redirect } from "next/navigation";
import { isInitialized } from "@/lib/auth/bootstrap";

/**
 * Reads the database to decide whether setup is still available, so it must
 * be evaluated per request rather than prerendered at build time.
 */
export const dynamic = "force-dynamic";

export default async function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isInitialized()) {
    redirect("/login");
  }

  return children;
}
