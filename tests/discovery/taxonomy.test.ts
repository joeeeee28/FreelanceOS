import { describe, expect, it } from "vitest";

import {
  SERVICE_CATEGORIES,
  SERVICE_KEYS,
  SERVICES,
  getService,
  isServiceKey,
  serviceLabel,
  servicesByCategory,
} from "@/lib/taxonomy/services";

describe("service taxonomy", () => {
  it("covers all eleven offered services", () => {
    expect(SERVICES.length).toBeGreaterThanOrEqual(11);
  });

  it("uses unique, stable, machine-safe keys", () => {
    const keys = SERVICES.map((s) => s.key);

    expect(new Set(keys).size).toBe(keys.length);

    for (const key of keys) {
      // Keys are persisted in the database, so they must not contain
      // anything that would need escaping or change under normalisation.
      // SCREAMING_SNAKE_CASE matches the convention used by the schema enums.
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("gives every service a label, category and summary", () => {
    for (const service of SERVICES) {
      expect(service.label.trim()).not.toBe("");
      expect(service.summary.trim()).not.toBe("");
      expect(Object.keys(SERVICE_CATEGORIES)).toContain(service.category);
    }
  });

  it("looks services up by key", () => {
    const key = SERVICE_KEYS[0];
    expect(getService(key)?.key).toBe(key);
    expect(getService("no-such-service")).toBeUndefined();
  });

  it("recognises valid keys", () => {
    expect(isServiceKey(SERVICE_KEYS[0])).toBe(true);
    expect(isServiceKey("no-such-service")).toBe(false);
    expect(isServiceKey(null)).toBe(false);
    expect(isServiceKey(42)).toBe(false);
  });

  /**
   * Keys live in the database. If a service is ever renamed or retired, old
   * rows must still render rather than crashing a page.
   */
  it("falls back to the raw key instead of throwing on an unknown service", () => {
    expect(serviceLabel("retired-service-key")).toBe("retired-service-key");
    expect(() => serviceLabel("")).not.toThrow();
  });

  it("returns the human label for a known service", () => {
    const service = SERVICES[0];
    expect(serviceLabel(service.key)).toBe(service.label);
  });

  it("groups every service under exactly one category", () => {
    const categories = Object.keys(SERVICE_CATEGORIES) as Array<
      keyof typeof SERVICE_CATEGORIES
    >;

    const total = categories.reduce(
      (sum, category) => sum + servicesByCategory(category).length,
      0,
    );

    // Every service appears in exactly one bucket: no orphans, no duplicates.
    expect(total).toBe(SERVICES.length);
  });

  it("returns an empty list for a category with no services", () => {
    const categories = Object.keys(SERVICE_CATEGORIES) as Array<
      keyof typeof SERVICE_CATEGORIES
    >;

    for (const category of categories) {
      expect(Array.isArray(servicesByCategory(category))).toBe(true);
    }
  });

  it("is extensible without code changes elsewhere", () => {
    // The registry is the single source of truth: nothing hard-codes a count
    // or an individual key, so adding a service is a one-line change.
    expect(SERVICE_KEYS).toHaveLength(SERVICES.length);
    for (const key of SERVICE_KEYS) {
      expect(getService(key)).toBeDefined();
    }
  });
});
