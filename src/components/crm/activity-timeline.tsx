import Link from "next/link";
import type { ActivityType } from "@prisma/client";

import { formatDateTimeInZone } from "@/lib/time/zoned";
import { relativeLabel } from "@/lib/time/relative";
import { Icon, humanise, type IconName } from "@/components/ui/domain";
import { cn } from "@/components/ui/primitives";

export interface TimelineEntry {
  id: string;
  type: ActivityType;
  title: string;
  description?: string | null;
  createdAt: Date;
  leadId?: string | null;
  leadName?: string | null;
  contactName?: string | null;
}

/** Icon and accent per activity type, so the timeline scans at a glance. */
const TYPE_STYLE: Record<ActivityType, { icon: IconName; tone: string }> = {
  LEAD_CREATED: { icon: "plus", tone: "text-accent" },
  LEAD_UPDATED: { icon: "leads", tone: "text-muted-foreground" },
  RESEARCH_COMPLETED: { icon: "sparkle", tone: "text-accent" },
  CONTACT_ADDED: { icon: "contacts", tone: "text-accent" },
  STATUS_CHANGED: { icon: "pipeline", tone: "text-info" },
  NOTE_ADDED: { icon: "proposals", tone: "text-muted-foreground" },
  EMAIL_SENT: { icon: "outreach", tone: "text-info" },
  LINKEDIN_MESSAGE: { icon: "outreach", tone: "text-info" },
  INSTAGRAM_MESSAGE: { icon: "outreach", tone: "text-info" },
  FACEBOOK_MESSAGE: { icon: "outreach", tone: "text-info" },
  WHATSAPP_MESSAGE: { icon: "outreach", tone: "text-info" },
  PHONE_CALL: { icon: "payments", tone: "text-info" },
  FOLLOW_UP_SCHEDULED: { icon: "clock", tone: "text-warning" },
  FOLLOW_UP_COMPLETED: { icon: "check", tone: "text-success" },
  TASK_CREATED: { icon: "tasks", tone: "text-muted-foreground" },
  TASK_COMPLETED: { icon: "check", tone: "text-success" },
  DISCOVERY_CALL: { icon: "calendar", tone: "text-accent" },
  PROPOSAL_SENT: { icon: "proposals", tone: "text-accent" },
  OTHER: { icon: "sparkle", tone: "text-muted-foreground" },
};

/**
 * Shared activity timeline, used by the dashboard, the lead detail Activity
 * tab and the Activity page. Entries come from the Activity table only —
 * nothing is synthesised.
 */
export function ActivityTimeline({
  entries,
  timezone,
  now,
  showLead = true,
}: {
  entries: TimelineEntry[];
  timezone: string;
  now: Date;
  showLead?: boolean;
}) {
  return (
    <ol className="relative space-y-0">
      {entries.map((entry, index) => {
        const style = TYPE_STYLE[entry.type] ?? TYPE_STYLE.OTHER;
        const last = index === entries.length - 1;

        return (
          <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
            {/* Connector rail between markers. */}
            {!last ? (
              <span
                aria-hidden
                className="absolute left-[13px] top-7 bottom-0 w-px bg-border"
              />
            ) : null}

            <span
              className={cn(
                "relative z-10 mt-0.5 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border border-border bg-surface",
                style.tone,
              )}
            >
              <Icon name={style.icon} size={13} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="text-sm font-medium leading-snug text-foreground">
                  {entry.title}
                </p>
                <time
                  dateTime={entry.createdAt.toISOString()}
                  title={formatDateTimeInZone(entry.createdAt, timezone)}
                  className="shrink-0 text-2xs text-subtle-foreground"
                >
                  {relativeLabel(entry.createdAt, now)}
                </time>
              </div>

              <p className="mt-0.5 text-2xs uppercase tracking-wide text-subtle-foreground">
                {humanise(entry.type)}
                {showLead && entry.leadName ? (
                  <>
                    {" · "}
                    {entry.leadId ? (
                      <Link
                        href={`/leads/${entry.leadId}`}
                        className="normal-case tracking-normal text-accent hover:underline"
                      >
                        {entry.leadName}
                      </Link>
                    ) : (
                      <span className="normal-case tracking-normal">
                        {entry.leadName}
                      </span>
                    )}
                  </>
                ) : null}
                {entry.contactName ? (
                  <span className="normal-case tracking-normal">
                    {" · "}
                    {entry.contactName}
                  </span>
                ) : null}
              </p>

              {entry.description ? (
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {entry.description}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
