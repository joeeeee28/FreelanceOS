import Link from "next/link";

import type { DailyAction } from "@/lib/crm/daily-actions";
import { formatDateTimeInZone, isOverdue } from "@/lib/time/zoned";
import { relativeLabel } from "@/lib/time/relative";
import { Icon, PriorityBadge, PriorityRail, humanise } from "@/components/ui/domain";
import { cn } from "@/components/ui/primitives";

/** Deep-links an action to the page where the work actually happens. */
export function actionHref(action: DailyAction): string {
  if (action.leadId) return `/leads/${action.leadId}`;
  if (action.taskId) return "/tasks";
  if (action.followUpId) return "/follow-ups";
  return "/leads";
}

/** The call to action matches the kind of work the engine identified. */
const CTA: Record<DailyAction["type"], string> = {
  OVERDUE_FOLLOW_UP: "Send follow-up",
  FOLLOW_UP_DUE_TODAY: "Send follow-up",
  DISCOVERY_CALL_TODAY: "Open call prep",
  RESPONDED_LEAD_NEEDS_ACTION: "Reply now",
  PROPOSAL_STAGE_FOLLOW_UP: "Chase proposal",
  OVERDUE_TASK: "Complete task",
  HIGH_SCORE_UNCONTACTED_LEAD: "Start outreach",
  NEW_QUALIFIED_LEAD: "Review lead",
};

export function actionKey(action: DailyAction) {
  return [
    action.type,
    action.leadId ?? "",
    action.taskId ?? "",
    action.followUpId ?? "",
  ].join("-");
}

/**
 * One row of "Today's Revenue Actions".
 *
 * Everything rendered here comes from the daily-action engine: nothing is
 * hardcoded, and the row is omitted entirely rather than padded when a field
 * is absent.
 */
export function ActionCard({
  action,
  timezone,
  now,
}: {
  action: DailyAction;
  timezone: string;
  now: Date;
}) {
  const overdue = action.dueAt ? isOverdue(action.dueAt, now) : false;

  return (
    <Link
      href={actionHref(action)}
      className={cn(
        "group relative flex items-start gap-3 overflow-hidden rounded-lg border border-border bg-surface px-4 py-3.5",
        "transition-colors hover:border-border-strong hover:bg-muted/40",
      )}
    >
      <PriorityRail priority={action.priority} />

      <div className="min-w-0 flex-1 pl-2">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={action.priority} />
          <span className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
            {humanise(action.type)}
          </span>
        </div>

        <p className="mt-1.5 text-sm font-semibold leading-snug text-foreground">
          {action.title}
        </p>

        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {action.description}
        </p>

        {action.dueAt ? (
          <p
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 text-xs",
              overdue ? "font-medium text-danger" : "text-muted-foreground",
            )}
          >
            <Icon name={overdue ? "alert" : "clock"} size={13} />
            {overdue ? "Overdue" : "Due"} {relativeLabel(action.dueAt, now)}
            <span className="text-subtle-foreground">
              · {formatDateTimeInZone(action.dueAt, timezone)}
            </span>
          </p>
        ) : null}
      </div>

      <span className="hidden shrink-0 items-center gap-1 self-center text-xs font-medium text-accent sm:inline-flex">
        {CTA[action.type]}
        <Icon
          name="chevronRight"
          size={13}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </Link>
  );
}
