export function normalizeTimezone(value: string) {
  const timezone = value.trim();

  try {
    new Intl.DateTimeFormat("en", {
      timeZone: timezone,
    }).format();

    return timezone;
  } catch {
    throw new Error("INVALID_TIMEZONE");
  }
}
