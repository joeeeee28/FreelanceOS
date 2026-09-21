import { redirect } from "next/navigation";
import { isInitialized } from "@/lib/auth/bootstrap";
import { getSessionUser } from "@/lib/auth/server";

export default async function Home() {
  if (!(await isInitialized())) {
    redirect("/setup");
  }

  const user = await getSessionUser();

  redirect(user ? "/dashboard" : "/login");
}
