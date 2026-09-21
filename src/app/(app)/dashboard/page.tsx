import Link from "next/link";

import { getDashboard } from "@/lib/crm/dashboard";
import type { DailyAction } from "@/lib/crm/daily-actions";
import { formatDateTimeInZone, formatInZone } from "@/lib/time/zoned";

const PRIORITY_STYLES: Record<DailyAction["priority"], string> = {
  URGENT: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
  HIGH: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  MEDIUM: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  LOW: "bg-muted text-muted-foreground border-border",
};

/** Deep-links an action to the page where the work actually happens. */
function actionHref(action: DailyAction): string {
  if (action.leadId) return `/leads/${action.leadId}`;
  if (action.taskId) return "/tasks";
  if (action.followUpId) return "/follow-ups";
  return "/leads";
}

export default async function DashboardPage() {
  const data = await getDashboard();

  const metrics: Array<[string, number]> = [
    ["Total Leads", data.metrics.totalLeads],
    ["Qualified", data.metrics.qualified],
    ["Active Opportunities", data.metrics.active],
    ["Follow-ups Due", data.metrics.followUpsDue],
    ["Overdue Follow-ups", data.metrics.overdueFollowUps],
    ["Open Tasks", data.metrics.openTasks],
    ["Average Score", data.metrics.averageScore],
    ["Won", data.metrics.won],
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold sm:text-3xl">Welcome to FreelanceOS</h1>
        <p className="mt-2 text-muted-foreground">
          Focus on the actions most likely to move your freelance pipeline forward.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatInZone(new Date(), data.timezone, { dateStyle: "full" })} · {data.timezone}
        </p>
      </header>

      <section>
        <h2 className="text-xl font-semibold">What should I do today?</h2>

        <div className="mt-4 space-y-3">
          {data.actions.length === 0 ? (
            <div className="rounded-xl border p-6">
              <p className="font-medium">Nothing is due right now.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.metrics.totalLeads === 0
                  ? "Add your first lead to start generating revenue actions."
                  : "No overdue follow-ups, no calls today, and no uncontacted high-score leads."}
              </p>
            </div>
          ) : (
            data.actions.map((action) => (
              <Link
                key={`${action.type}-${action.leadId ?? ""}-${action.taskId ?? ""}-${action.followUpId ?? ""}`}
                href={actionHref(action)}
                className="block rounded-xl border p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">{action.title}</p>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                      PRIORITY_STYLES[action.priority]
                    }`}
                  >
                    {action.priority}
                  </span>
                </div>

                <p className="mt-1 text-sm text-muted-foreground">{action.description}</p>

                {action.dueAt ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDateTimeInZone(action.dueAt, data.timezone)}
                  </p>
                ) : null}
              </Link>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([name, value]) => (
          <div key={name} className="rounded-xl border p-5">
            <p className="text-sm text-muted-foreground">{name}</p>
            <p className="mt-2 text-3xl font-semibold">{value}</p>
          </div>
        ))}
      </section>

      {data.metrics.totalLeads === 0 ? (
        <section className="rounded-xl border p-8 text-center">
          <h2 className="text-xl font-semibold">Your workspace is ready</h2>
          <p className="mt-2 text-muted-foreground">
            Add your first real lead to start building your freelance pipeline.
          </p>
          <Link
            href="/leads/new"
            className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground"
          >
            Add Lead
          </Link>
        </section>
      ) : null}
    </div>
  );
}
