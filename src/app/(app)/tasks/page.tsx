import Link from "next/link";
import type { TaskPriority, TaskStatus } from "@prisma/client";

import { listTasks } from "@/lib/crm/tasks";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";
import { InlineAction } from "@/components/crm/lead-detail-panels";

const STATUSES: TaskStatus[] = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];
const PRIORITIES: TaskPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const DUE_OPTIONS = ["overdue", "today", "upcoming", "none"] as const;

function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const status = STATUSES.includes(params.status as TaskStatus)
    ? (params.status as TaskStatus)
    : undefined;

  const priority = PRIORITIES.includes(params.priority as TaskPriority)
    ? (params.priority as TaskPriority)
    : undefined;

  const due = (DUE_OPTIONS as readonly string[]).includes(params.due ?? "")
    ? (params.due as (typeof DUE_OPTIONS)[number])
    : undefined;

  const page = Number(params.page) || 1;

  const [result, { formatDateTime }] = await Promise.all([
    listTasks({ status, priority, due, page }),
    getWorkspaceTimeFormatters(),
  ]);

  const query = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/tasks?${qs}` : "/tasks";
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-muted-foreground">
          {result.total === 0 ? "Nothing scheduled." : `${result.total} task${result.total === 1 ? "" : "s"}`}
        </p>
      </header>

      <form method="GET" className="grid gap-3 rounded-xl border p-4 sm:grid-cols-4">
        <label className="space-y-1">
          <span className="text-xs font-medium">Status</span>
          <select
            name="status"
            defaultValue={params.status ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Priority</span>
          <select
            name="priority"
            defaultValue={params.priority ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Due</span>
          <select
            name="due"
            defaultValue={params.due ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">Any time</option>
            <option value="overdue">Overdue</option>
            <option value="today">Today</option>
            <option value="upcoming">Upcoming</option>
            <option value="none">No due date</option>
          </select>
        </label>

        <div className="flex items-end gap-2">
          <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
            Filter
          </button>
          <Link href="/tasks" className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
            Clear
          </Link>
        </div>
      </form>

      {result.items.length === 0 ? (
        <div className="rounded-xl border p-8 text-center">
          <p className="font-medium">No tasks found.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Tasks are created from a lead&apos;s page, so your work stays linked to revenue.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {result.items.map((task) => (
            <div
              key={task.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-4"
            >
              <div className="min-w-0">
                <p className="font-medium">{task.title}</p>
                <p className="text-sm text-muted-foreground">
                  {task.lead ? (
                    <Link href={`/leads/${task.lead.id}`} className="hover:underline">
                      {task.lead.companyName}
                    </Link>
                  ) : (
                    "General task"
                  )}
                  {task.contact ? ` · ${task.contact.fullName}` : ""}
                  {" · "}
                  {humanise(task.priority)} · {humanise(task.status)}
                </p>
                {task.dueAt ? (
                  <p className="mt-1 text-sm">Due {formatDateTime(task.dueAt)}</p>
                ) : null}
              </div>

              {task.status !== "DONE" && task.status !== "CANCELLED" ? (
                <div className="flex gap-2">
                  <InlineAction id={task.id} kind="completeTask" label="Complete" />
                  <InlineAction
                    id={task.id}
                    kind="cancelTask"
                    label="Cancel"
                    variant="danger"
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {result.totalPages > 1 ? (
        <nav className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Page {result.page} of {result.totalPages}
          </p>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link
                href={query({ page: result.page - 1 })}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Previous
              </Link>
            ) : null}
            {result.page < result.totalPages ? (
              <Link
                href={query({ page: result.page + 1 })}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Next
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
