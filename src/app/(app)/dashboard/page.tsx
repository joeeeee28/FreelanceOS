import Link from "next/link";
import { getDashboard } from "@/lib/crm/dashboard";
import { formatDateTimeInZone, formatInZone } from "@/lib/time/zoned";

export default async function DashboardPage() {
  const data = await getDashboard();

  const metrics = [
    ["Total Leads", data.metrics.totalLeads],
    ["Qualified", data.metrics.qualified],
    ["Active Opportunities", data.metrics.active],
    ["Follow-ups Due", data.metrics.followUpsDue],
    ["Discovery Calls", data.metrics.discoveryCalls],
    ["Proposals", data.metrics.proposals],
    ["Won", data.metrics.won],
    ["Lost", data.metrics.lost],
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">
          Welcome to FreelanceOS
        </h1>
        <p className="mt-2 text-muted-foreground">
          Focus on the actions most likely to move your
          freelance pipeline forward.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatInZone(new Date(), data.timezone, {
            dateStyle: "full",
          })}{" "}
          · {data.timezone}
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([name, value]) => (
          <div
            key={String(name)}
            className="rounded-xl border p-5"
          >
            <p className="text-sm text-muted-foreground">
              {name}
            </p>
            <p className="mt-2 text-3xl font-semibold">
              {value}
            </p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="text-xl font-semibold">
          What should I do today?
        </h2>

        <div className="mt-4 space-y-2">
          {data.todaysFollowUps.length === 0 &&
          data.overdueTasks.length === 0 ? (
            <div className="rounded-xl border p-6 text-muted-foreground">
              Nothing urgent is due right now.
            </div>
          ) : null}

          {data.todaysFollowUps.map((item) => (
            <Link
              key={item.id}
              href={`/leads/${item.leadId}`}
              className="block rounded-xl border p-4 hover:bg-muted"
            >
              <span>Follow up with {item.lead.companyName}</span>
              <span className="ml-2 text-sm text-muted-foreground">
                {formatDateTimeInZone(item.scheduledAt, data.timezone)}
              </span>
            </Link>
          ))}

          {data.overdueTasks.map((task) => (
            <Link
              key={task.id}
              href="/tasks"
              className="block rounded-xl border p-4 hover:bg-muted"
            >
              <span>Overdue: {task.title}</span>
              {task.dueAt ? (
                <span className="ml-2 text-sm text-muted-foreground">
                  was due {formatDateTimeInZone(task.dueAt, data.timezone)}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </section>

      {data.metrics.totalLeads === 0 && (
        <section className="rounded-xl border p-8 text-center">
          <h2 className="text-xl font-semibold">
            Your workspace is ready
          </h2>
          <p className="mt-2 text-muted-foreground">
            Add your first real lead to start building
            your freelance pipeline.
          </p>
          <Link
            href="/leads/new"
            className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground"
          >
            Add Lead
          </Link>
        </section>
      )}
    </div>
  );
}
