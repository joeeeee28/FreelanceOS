/**
 * robots.txt parsing and enforcement.
 *
 * The rule this implements is absolute: if a site's robots.txt disallows a
 * path for our agent, we do not fetch it. There is no override, no "polite
 * mode", no configuration flag. A disallowed URL is recorded as BLOCKED and
 * the pipeline moves on.
 *
 * Implements the widely-followed conventions from RFC 9309: longest-match
 * wins, Allow beats Disallow on equal specificity, `*` and `$` wildcards, and
 * the most specific matching user-agent group is the only one that applies.
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsPolicy {
  groups: RobotsGroup[];
  sitemaps: string[];
  /**
   * True when robots.txt could not be read. Callers decide what that means;
   * see `robotsUnavailablePolicy`.
   */
  unavailable: boolean;
}

const MAX_ROBOTS_BYTES = 512 * 1024;

/** Parses robots.txt into groups. Unknown directives are ignored. */
export function parseRobots(text: string): RobotsPolicy {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one group of rules.
  let lastLineWasAgent = false;

  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line === "") continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!lastLineWasAgent || current === null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;

    if (field === "sitemap") {
      if (value !== "") sitemaps.push(value);
      continue;
    }

    if (current === null) continue;

    if (field === "allow") {
      current.rules.push({ allow: true, path: value });
    } else if (field === "disallow") {
      current.rules.push({ allow: false, path: value });
    } else if (field === "crawl-delay") {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) {
        current.crawlDelaySeconds = delay;
      }
    }
  }

  return { groups, sitemaps, unavailable: false };
}

/** A robots.txt we could not read. */
export function robotsUnavailablePolicy(): RobotsPolicy {
  return { groups: [], sitemaps: [], unavailable: true };
}

/**
 * Selects the group that applies to our agent.
 *
 * An exact agent match wins over `*`; if neither is present, nothing
 * restricts us.
 */
export function groupForAgent(
  policy: RobotsPolicy,
  userAgent: string,
): RobotsGroup | null {
  const agent = userAgent.toLowerCase();

  let wildcard: RobotsGroup | null = null;
  let specific: RobotsGroup | null = null;
  let specificLength = -1;

  for (const group of policy.groups) {
    for (const candidate of group.agents) {
      if (candidate === "*") {
        wildcard ??= group;
        continue;
      }
      // Substring match is what real crawlers use: "freelanceos-bot/1.0"
      // should be matched by a rule naming "freelanceos-bot".
      if (agent.includes(candidate) && candidate.length > specificLength) {
        specific = group;
        specificLength = candidate.length;
      }
    }
  }

  return specific ?? wildcard;
}

/** Matches a robots path pattern, supporting `*` and `$`. */
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === "") return false;

  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const segments = body.split("*");
  let index = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "") continue;

    if (i === 0) {
      // The first segment must match at the very start.
      if (!path.startsWith(segment)) return false;
      index = segment.length;
      continue;
    }

    const found = path.indexOf(segment, index);
    if (found === -1) return false;
    index = found + segment.length;
  }

  if (anchored) {
    const last = segments[segments.length - 1];
    // With a trailing "$" the pattern must consume the whole path.
    if (last === "") return segments.length === 1 ? path.length === 0 : true;
    return path.endsWith(last) && index === path.length;
  }

  return true;
}

/**
 * Decides whether a URL may be fetched.
 *
 * Longest matching rule wins; on a tie Allow wins, which is the behaviour
 * Google documents and site owners expect.
 */
export function isAllowed(
  policy: RobotsPolicy,
  url: string,
  userAgent: string,
): boolean {
  // If robots.txt is unreachable we do NOT invent permission for specific
  // paths, but we also do not treat the whole site as forbidden: the
  // convention (and RFC 9309) is that an unavailable robots.txt means
  // unrestricted. A 401/403 on robots.txt itself is handled by the caller,
  // which marks the source BLOCKED.
  if (policy.unavailable) return true;

  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    return false;
  }

  const group = groupForAgent(policy, userAgent);
  if (group === null) return true;

  let bestLength = -1;
  let bestAllow = true;

  for (const rule of group.rules) {
    if (!matchesPattern(rule.path, path)) continue;

    // Compare by pattern length: the more specific rule governs.
    const length = rule.path.length;
    if (length > bestLength) {
      bestLength = length;
      bestAllow = rule.allow;
    } else if (length === bestLength && rule.allow) {
      bestAllow = true;
    }
  }

  return bestLength === -1 ? true : bestAllow;
}

/** Crawl-delay requested by the site, if any. */
export function crawlDelayFor(
  policy: RobotsPolicy,
  userAgent: string,
): number | null {
  return groupForAgent(policy, userAgent)?.crawlDelaySeconds ?? null;
}
