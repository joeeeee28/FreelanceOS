export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function cleanText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
