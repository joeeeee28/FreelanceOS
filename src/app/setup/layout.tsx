import { redirect } from "next/navigation";
import { isInitialized } from "@/lib/auth/bootstrap";

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
