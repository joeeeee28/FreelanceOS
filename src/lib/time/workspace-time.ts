import "server-only";
import { requireUser } from "@/lib/auth/require-user";
import { formatDateTimeInZone, formatInZone, todayRangeInZone } from "./zoned";

/**
 * Server-side accessor for the current workspace's timezone.
 *
 * Every page that renders or compares dates goes through this, so the zone is
 * resolved in exactly one place and components never reach for
 * `toLocaleString()` (which silently uses the server's zone).
 */
export async function getWorkspaceTimezone(): Promise<string> {
  const { workspace } = await requireUser();
  return workspace.timezone;
}

/** Formatters bound to the current workspace's timezone. */
export async function getWorkspaceTimeFormatters() {
  const timeZone = await getWorkspaceTimezone();

  return {
    timeZone,
    formatDate: (instant: Date) => formatInZone(instant, timeZone),
    formatDateTime: (instant: Date) => formatDateTimeInZone(instant, timeZone),
    today: (now?: Date) => todayRangeInZone(timeZone, now),
  };
}
