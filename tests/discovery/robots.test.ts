import { describe, expect, it } from "vitest";

import {
  crawlDelayFor,
  groupForAgent,
  isAllowed,
  parseRobots,
  robotsUnavailablePolicy,
} from "@/lib/discovery/robots";

const UA = "FreelanceOS-Bot/1.0";

describe("parseRobots", () => {
  it("parses groups, rules and sitemaps", () => {
    const policy = parseRobots(`
      # comment
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
      Crawl-delay: 2

      User-agent: BadBot
      Disallow: /

      Sitemap: https://example.com/sitemap.xml
    `);

    expect(policy.groups).toHaveLength(2);
    expect(policy.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(policy.groups[0].crawlDelaySeconds).toBe(2);
  });

  it("merges consecutive user-agent lines into one group", () => {
    const policy = parseRobots(`
      User-agent: alpha
      User-agent: beta
      Disallow: /private
    `);

    expect(policy.groups).toHaveLength(1);
    expect(policy.groups[0].agents).toEqual(["alpha", "beta"]);
  });

  it("ignores comments and unknown directives", () => {
    const policy = parseRobots(`
      # just a comment
      User-agent: *
      Disallow: /x # trailing comment
      Unknown-Directive: whatever
    `);

    expect(policy.groups[0].rules).toEqual([{ allow: false, path: "/x" }]);
  });

  it("survives an empty or malformed file", () => {
    expect(parseRobots("").groups).toEqual([]);
    expect(parseRobots("garbage without colons").groups).toEqual([]);
  });
});

describe("groupForAgent", () => {
  const policy = parseRobots(`
    User-agent: *
    Disallow: /everyone

    User-agent: freelanceos-bot
    Disallow: /specific
  `);

  it("prefers a named group over the wildcard", () => {
    expect(groupForAgent(policy, UA)?.rules[0].path).toBe("/specific");
  });

  it("falls back to the wildcard for other agents", () => {
    expect(groupForAgent(policy, "SomeOtherBot")?.rules[0].path).toBe("/everyone");
  });
});

describe("isAllowed", () => {
  it("blocks a disallowed path", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /admin");

    expect(isAllowed(policy, "https://example.com/admin", UA)).toBe(false);
    expect(isAllowed(policy, "https://example.com/admin/users", UA)).toBe(false);
    expect(isAllowed(policy, "https://example.com/public", UA)).toBe(true);
  });

  it("lets a more specific Allow override a broad Disallow", () => {
    const policy = parseRobots(
      "User-agent: *\nDisallow: /admin\nAllow: /admin/public",
    );

    expect(isAllowed(policy, "https://example.com/admin/secret", UA)).toBe(false);
    expect(isAllowed(policy, "https://example.com/admin/public", UA)).toBe(true);
  });

  it("treats Disallow: / as a total block", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /");

    expect(isAllowed(policy, "https://example.com/", UA)).toBe(false);
    expect(isAllowed(policy, "https://example.com/anything", UA)).toBe(false);
  });

  it("treats an empty Disallow as permission", () => {
    const policy = parseRobots("User-agent: *\nDisallow:");

    expect(isAllowed(policy, "https://example.com/anything", UA)).toBe(true);
  });

  it("supports * and $ wildcards", () => {
    const policy = parseRobots(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/private",
    );

    expect(isAllowed(policy, "https://example.com/files/report.pdf", UA)).toBe(false);
    expect(isAllowed(policy, "https://example.com/files/report.pdf?x=1", UA)).toBe(true);
    expect(isAllowed(policy, "https://example.com/tmp/a/private", UA)).toBe(false);
    expect(isAllowed(policy, "https://example.com/tmp/a/public", UA)).toBe(true);
  });

  it("applies rules only from the matching group", () => {
    const policy = parseRobots(`
      User-agent: *
      Disallow: /

      User-agent: freelanceos-bot
      Allow: /
      Disallow: /private
    `);

    // Our named group grants access that the wildcard group denies.
    expect(isAllowed(policy, "https://example.com/catalogue", UA)).toBe(true);
    expect(isAllowed(policy, "https://example.com/private", UA)).toBe(false);
    // A different crawler would be fully blocked.
    expect(isAllowed(policy, "https://example.com/catalogue", "OtherBot")).toBe(false);
  });

  it("allows everything when the site publishes no restrictions", () => {
    expect(isAllowed(parseRobots(""), "https://example.com/x", UA)).toBe(true);
  });

  it("treats an unreachable robots.txt as unrestricted", () => {
    // RFC 9309: an unavailable robots.txt does not itself forbid crawling.
    // A 401/403 on robots.txt is handled separately by marking the source
    // BLOCKED, so this default cannot be used to bypass an access control.
    expect(isAllowed(robotsUnavailablePolicy(), "https://example.com/x", UA)).toBe(
      true,
    );
  });

  it("rejects an unparseable URL rather than assuming permission", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /x"), "not a url", UA)).toBe(
      false,
    );
  });
});

describe("crawlDelayFor", () => {
  it("reads the delay from the matching group", () => {
    const policy = parseRobots("User-agent: *\nCrawl-delay: 5");
    expect(crawlDelayFor(policy, UA)).toBe(5);
  });

  it("returns null when none is set", () => {
    expect(crawlDelayFor(parseRobots("User-agent: *"), UA)).toBeNull();
  });
});
