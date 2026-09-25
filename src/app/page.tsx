import { redirect } from "next/navigation";
import { isInitialized } from "@/lib/auth/bootstrap";
import { getSessionUser } from "@/lib/auth/server";

/**
 * This route reads the database (initialization state + session) on every
 * request, so it must never be statically prerendered at build time.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isInitialized())) {
    redirect("/setup");
  }

  const user = await getSessionUser();

  redirect(user ? "/dashboard" : "/login");
}
