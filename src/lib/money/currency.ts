export const CURRENCIES = [
  "INR",
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "AED",
] as const;

export function normalizeCurrency(value = "INR") {
  const currency = value.trim().toUpperCase();

  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new Error("UNSUPPORTED_CURRENCY");
  }

  return currency;
}
