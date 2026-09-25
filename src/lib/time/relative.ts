/**
 * Compact relative labels ("2h ago", "in 3d") for timeline and table cells.
 *
 * Pure and deterministic: it takes the reference instant as an argument rather
 * than reading the clock, so it renders identically on the server and in tests.
 * Absolute, timezone-correct values are still shown via `formatDateTimeInZone`
 * wherever precision matters — this is only a density aid.
 */
export function relativeLabel(
  instant: Date | string,
  now: Date = new Date(),
): string {
  const then = instant instanceof Date ? instant : new Date(instant);
  const diffMs = then.getTime() - now.getTime();
  const future = diffMs > 0;
  const seconds = Math.abs(diffMs) / 1000;

  if (seconds < 45) return future ? "in a moment" : "just now";

  const units: Array<[number, string]> = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
  ];

  let label: string;

  if (seconds < 3600) {
    label = `${Math.round(seconds / units[0][0])}m`;
  } else if (seconds < 86400) {
    label = `${Math.round(seconds / units[1][0])}h`;
  } else if (seconds < 86400 * 30) {
    label = `${Math.round(seconds / units[2][0])}d`;
  } else if (seconds < 86400 * 365) {
    label = `${Math.round(seconds / (86400 * 30))}mo`;
  } else {
    label = `${Math.round(seconds / (86400 * 365))}y`;
  }

  return future ? `in ${label}` : `${label} ago`;
}
