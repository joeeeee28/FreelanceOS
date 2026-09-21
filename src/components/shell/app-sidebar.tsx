import Link from "next/link";

import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export function AppSidebar({
  userName,
  userEmail,
  workspaceName,
}: {
  userName: string;
  userEmail: string;
  workspaceName: string;
}) {
  return (
    <aside className="border-b bg-background md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col md:border-r">
      <div className="p-5">
        <Link href="/dashboard" className="text-xl font-bold">
          FreelanceOS
        </Link>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={workspaceName}>
          {workspaceName}
        </p>
      </div>

      <NavLinks />

      <div className="space-y-3 border-t p-3 md:mt-auto">
        <ThemeToggle />
        <UserMenu userName={userName} userEmail={userEmail} />
      </div>
    </aside>
  );
}
