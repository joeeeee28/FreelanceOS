import { requireUser } from "@/lib/auth/require-user";
import { assertBootEnv } from "@/lib/boot";
import { getDailyActions } from "@/lib/crm/daily-actions";
import { AppShell } from "@/components/shell/app-shell";

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

  // The top-bar indicator reuses the existing daily-action engine rather than
  // inventing a separate notification concept. Count only; the dashboard
  // renders the detail.
  const actions = await getDailyActions();

  return (
    <AppShell
      // Only non-sensitive identity reaches the client: no password hash, no
      // internal ids, no session material.
      userName={user.name ?? user.email.split("@")[0]}
      userEmail={user.email}
      workspaceName={workspace.name}
      dueActionCount={actions.length}
    >
      {children}
    </AppShell>
  );
}
