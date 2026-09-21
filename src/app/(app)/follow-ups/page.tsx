import Link from "next/link";
import type {
  FollowUpChannel,
  FollowUpSequence,
  FollowUpStatus,
} from "@prisma/client";

import { listFollowUps } from "@/lib/crm/follow-ups";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";
import { InlineAction } from "@/components/crm/lead-detail-panels";

const STATUSES: FollowUpStatus[] = ["SCHEDULED", "COMPLETED", "CANCELLED"];

const CHANNELS: FollowUpChannel[] = [
  "EMAIL",
  "LINKEDIN",
  "INSTAGRAM",
  "FACEBOOK",
  "WHATSAPP",
  "PHONE",
  "UPWORK",
  "FIVERR",
  "CONTRA",
  "COLD_EMAIL",
  "REFERRAL",
  "OTHER",
];

const SEQUENCES: FollowUpSequence[] = ["INITIAL", "FU1", "FU2", "FU3", "NURTURE"];

function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const result = await listFollowUps({
    status: STATUSES.includes(params.status as FollowUpStatus)
      ? (params.status as FollowUpStatus)
      : undefined,
    channel: CHANNELS.includes(params.channel as FollowUpChannel)
      ? (params.channel as FollowUpChannel)
      : undefined,
    sequence: SEQUENCES.includes(params.sequence as FollowUpSequence)
      ? (params.sequence as FollowUpSequence)
      : undefined,
    due: (["overdue", "today", "upcoming"] as const).includes(
      params.due as "overdue" | "today" | "upcoming",
    )
      ? (params.due as "overdue" | "today" | "upcoming")
      : undefined,
    page: Number(params.page) || 1,
  });

  const { formatDateTime } = await getWorkspaceTimeFormatters();

  const query = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/follow-ups?${qs}` : "/follow-ups";
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Follow-ups</h1>
        <p className="text-muted-foreground">
          {result.total === 0
            ? "Nothing scheduled."
            : `${result.total} follow-up${result.total === 1 ? "" : "s"}`}
        </p>
      </header>

      <form method="GET" className="grid gap-3 rounded-xl border p-4 sm:grid-cols-5">
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
          <span className="text-xs font-medium">Channel</span>
          <select
            name="channel"
            defaultValue={params.channel ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {CHANNELS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Sequence</span>
          <select
            name="sequence"
            defaultValue={params.sequence ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {SEQUENCES.map((value) => (
              <option key={value} value={value}>
                {value}
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
          </select>
        </label>

        <div className="flex items-end gap-2">
          <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
            Filter
          </button>
          <Link href="/follow-ups" className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
            Clear
          </Link>
        </div>
      </form>

      {result.items.length === 0 ? (
        <div className="rounded-xl border p-8 text-center">
          <p className="font-medium">No follow-ups found.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Schedule follow-ups from a lead&apos;s page to keep conversations moving.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {result.items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-4"
            >
              <div>
                <Link href={`/leads/${item.lead.id}`} className="font-medium hover:underline">
                  {item.lead.companyName}
                </Link>
                <p className="text-sm text-muted-foreground">
                  {item.sequence} · {humanise(item.channel)} · {humanise(item.status)}
                  {item.contact ? ` · ${item.contact.fullName}` : ""}
                </p>
                <p className="mt-1 text-sm">{formatDateTime(item.scheduledAt)}</p>
              </div>

              {item.status === "SCHEDULED" ? (
                <div className="flex gap-2">
                  <InlineAction id={item.id} kind="completeFollowUp" label="Complete" />
                  <InlineAction
                    id={item.id}
                    kind="cancelFollowUp"
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
