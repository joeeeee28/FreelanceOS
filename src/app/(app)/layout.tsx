import { requireUser } from "@/lib/auth/require-user";
import { assertBootEnv } from "@/lib/boot";
import { AppSidebar } from "@/components/shell/app-sidebar";

/**
 * Every authenticated page is per-request by definition: it reads the session
 * cookie and queries workspace-scoped data. Declaring it here (inherited by
 * all child segments) keeps `next build` from attempting to prerender them,
 * which would require a live database at build time.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fails fast with a clear message if the deployment is misconfigured.
  assertBootEnv();

  const { user, workspace } = await requireUser();

  return (
    <div className="min-h-screen bg-background">
      {/* Only non-sensitive identity is passed to the client: no password
          hash, no internal ids, no session material. */}
      <AppSidebar
        // `name` is nullable in the schema; fall back to the email local part
        // rather than rendering an empty label.
        userName={user.name ?? user.email.split("@")[0]}
        userEmail={user.email}
        workspaceName={workspace.name}
      />

      <main className="md:pl-64">
        <div className="mx-auto max-w-7xl p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
