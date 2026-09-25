import Link from "next/link";
import type { TaskPriority, TaskStatus } from "@prisma/client";

import { countTaskViews, listTasks } from "@/lib/crm/tasks";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";
import { relativeLabel } from "@/lib/time/relative";
import { isOverdue } from "@/lib/time/zoned";
import { InlineAction } from "@/components/crm/lead-detail-panels";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  cn,
} from "@/components/ui/primitives";
import {
  Icon,
  PriorityBadge,
  PriorityRail,
  humanise,
} from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { FilterBar, FilterSelect } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";

const STATUSES: TaskStatus[] = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];
const PRIORITIES: TaskPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const DUE_OPTIONS = ["overdue", "today", "upcoming", "none"] as const;

/**
 * The four headline views.
 *
 * Each is just a preset over the existing `listTasks` filters, so the server
 * query is unchanged — the tabs are a presentation layer, not new logic.
 */
const VIEWS = {
  today: { due: "today", status: undefined },
  upcoming: { due: "upcoming", status: undefined },
  overdue: { due: "overdue", status: undefined },
  completed: { due: undefined, status: "DONE" as TaskStatus },
  all: { due: undefined, status: undefined },
} as const;

type ViewId = keyof typeof VIEWS;

function parseView(value?: string): ViewId {
  return value && value in VIEWS ? (value as ViewId) : "today";
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const now = new Date();
  const params = await searchParams;

  const view = parseView(params.view);
  const preset = VIEWS[view];

  // Explicit filter controls override the view preset.
  const status = STATUSES.includes(params.status as TaskStatus)
    ? (params.status as TaskStatus)
    : preset.status;

  const priority = PRIORITIES.includes(params.priority as TaskPriority)
    ? (params.priority as TaskPriority)
    : undefined;

  const due = (DUE_OPTIONS as readonly string[]).includes(params.due ?? "")
    ? (params.due as (typeof DUE_OPTIONS)[number])
    : preset.due;

  const page = Number(params.page) || 1;

  const [result, counts, { formatDateTime }] = await Promise.all([
    listTasks({ status, priority, due, page }),
    countTaskViews(),
    getWorkspaceTimeFormatters(),
  ]);

  const hasFilters = Boolean(params.status || params.priority || params.due);

  const linkTo = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/tasks?${qs}` : "/tasks";
  };

  const viewHref = (id: ViewId) => `/tasks?view=${id}`;

  const tabs: TabItem[] = [
    { id: "today", label: "Today", href: viewHref("today"), count: counts.today },
    {
      id: "upcoming",
      label: "Upcoming",
      href: viewHref("upcoming"),
      count: counts.upcoming,
    },
    {
      id: "overdue",
      label: "Overdue",
      href: viewHref("overdue"),
      count: counts.overdue,
    },
    {
      id: "completed",
      label: "Completed",
      href: viewHref("completed"),
      count: counts.completed,
    },
    { id: "all", label: "All", href: viewHref("all") },
  ];

  const emptyCopy: Record<ViewId, { title: string; description: string }> = {
    today: {
      title: "Nothing due today",
      description:
        "No task is scheduled for today in your workspace timezone. Check Upcoming, or add a task from a lead.",
    },
    upcoming: {
      title: "Nothing scheduled ahead",
      description:
        "You have no future-dated tasks. Planning the next step on a lead keeps your pipeline moving.",
    },
    overdue: {
      title: "Nothing overdue",
      description:
        "Every task with a due date is still current. That is exactly where you want to be.",
    },
    completed: {
      title: "No completed tasks yet",
      description:
        "Tasks you finish are kept here as a record of the work you have done.",
    },
    all: {
      title: "No tasks yet",
      description:
        "Tasks are created from a lead's page, so your work always stays linked to revenue.",
    },
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tasks"
        description="Concrete work items, each tied to a lead so effort stays connected to revenue."
        actions={
          <LinkButton href="/leads" variant="secondary">
            <Icon name="leads" size={14} />
            Add from a lead
          </LinkButton>
        }
      />

      <Tabs items={tabs} active={view} label="Task views" />

      <FilterBar active={hasFilters} clearHref={viewHref(view)}>
        <FilterSelect
          label="Status"
          name="status"
          defaultValue={params.status}
          placeholder="Any status"
          options={STATUSES.map((value) => ({
            value,
            label: humanise(value),
          }))}
        />

        <FilterSelect
          label="Priority"
          name="priority"
          defaultValue={params.priority}
          placeholder="Any priority"
          options={PRIORITIES.map((value) => ({
            value,
            label: humanise(value),
          }))}
        />

        <FilterSelect
          label="Due"
          name="due"
          defaultValue={params.due}
          placeholder="Any time"
          options={[
            { value: "overdue", label: "Overdue" },
            { value: "today", label: "Today" },
            { value: "upcoming", label: "Upcoming" },
            { value: "none", label: "No due date" },
          ]}
        />

        {/* Keeps the active view when the filter form submits. */}
        <input type="hidden" name="view" value={view} />
      </FilterBar>

      {result.items.length === 0 ? (
        <EmptyState
          icon={<Icon name="tasks" />}
          title={hasFilters ? "No tasks match these filters" : emptyCopy[view].title}
          description={
            hasFilters
              ? "Try a different status, priority or due window."
              : emptyCopy[view].description
          }
          action={
            hasFilters ? (
              <LinkButton href={viewHref(view)} variant="secondary" size="sm">
                Clear filters
              </LinkButton>
            ) : (
              <LinkButton href="/leads" variant="primary" size="sm">
                Go to leads
              </LinkButton>
            )
          }
        />
      ) : (
        <Card className="divide-y divide-border">
          {result.items.map((task) => {
            const open = task.status !== "DONE" && task.status !== "CANCELLED";
            const overdue = task.dueAt ? open && isOverdue(task.dueAt, now) : false;

            return (
              <div
                key={task.id}
                className="flex flex-wrap items-start gap-3 p-4 first:rounded-t-xl last:rounded-b-xl hover:bg-muted/30"
              >
                <PriorityRail priority={task.priority} />

                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm font-medium leading-snug",
                      !open && "text-muted-foreground line-through",
                    )}
                  >
                    {task.title}
                  </p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <PriorityBadge priority={task.priority} />

                    <Badge
                      tone={
                        task.status === "DONE"
                          ? "success"
                          : task.status === "CANCELLED"
                            ? "neutral"
                            : task.status === "IN_PROGRESS"
                              ? "info"
                              : "neutral"
                      }
                    >
                      {humanise(task.status)}
                    </Badge>

                    {task.lead ? (
                      <Link
                        href={`/leads/${task.lead.id}?tab=tasks`}
                        className="text-2xs font-medium text-accent hover:underline"
                      >
                        {task.lead.companyName}
                      </Link>
                    ) : (
                      <span className="text-2xs text-subtle-foreground">
                        General task
                      </span>
                    )}

                    {task.contact ? (
                      <span className="text-2xs text-subtle-foreground">
                        · {task.contact.fullName}
                      </span>
                    ) : null}
                  </div>

                  {task.description ? (
                    <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                      {task.description}
                    </p>
                  ) : null}

                  {task.dueAt ? (
                    <p
                      className={cn(
                        "mt-1.5 inline-flex items-center gap-1.5 text-xs",
                        overdue ? "font-medium text-danger" : "text-muted-foreground",
                      )}
                    >
                      <Icon name={overdue ? "alert" : "clock"} size={12} />
                      {overdue ? "Overdue" : "Due"} {relativeLabel(task.dueAt, now)}
                      <span className="text-subtle-foreground">
                        · {formatDateTime(task.dueAt)}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-1.5 text-xs text-subtle-foreground">
                      No due date
                    </p>
                  )}
                </div>

                {open ? (
                  <div className="flex shrink-0 gap-2">
                    <InlineAction
                      id={task.id}
                      kind="completeTask"
                      label="Complete"
                    />
                    <InlineAction
                      id={task.id}
                      kind="cancelTask"
                      label="Cancel"
                      variant="danger"
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}

      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        totalPages={result.totalPages}
        linkTo={linkTo}
        noun="task"
      />
    </div>
  );
}
