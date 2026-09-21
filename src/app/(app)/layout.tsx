import { requireUser } from "@/lib/auth/require-user";
import { AppSidebar } from "@/components/shell/app-sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar />

      <main className="md:pl-64">
        <div className="mx-auto max-w-7xl p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
