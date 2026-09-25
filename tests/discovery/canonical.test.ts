import { describe, expect, it } from "vitest";

import {
  canonicalCompanyName,
  canonicalDomain,
  canonicalEmail,
  canonicalPersonName,
  canonicalPhone,
  canonicalUrl,
} from "@/lib/discovery/canonical";

/**
 * Canonicalisation is the foundation of entity resolution: if two sources
 * describing one business do not produce the same key, the CRM ends up with
 * duplicates. These tests pin the exact behaviour.
 */

describe("canonicalDomain", () => {
  it("strips scheme, www, path, query and case", () => {
    for (const input of [
      "https://www.Example.com/contact?utm_source=x",
      "http://example.com",
      "EXAMPLE.COM",
      "www.example.com/",
      "example.com.",
    ]) {
      expect(canonicalDomain(input)).toBe("example.com");
    }
  });

  it("keeps three labels for multi-part public suffixes", () => {
    expect(canonicalDomain("https://www.acme.co.uk/about")).toBe("acme.co.uk");
    expect(canonicalDomain("shop.acme.com.au")).toBe("acme.com.au");
    expect(canonicalDomain("https://foo.bar.co.in")).toBe("bar.co.in");
  });

  it("keeps meaningful subdomains", () => {
    // Only cosmetic prefixes are dropped; "shop" could be a distinct business.
    expect(canonicalDomain("https://shop.example.com")).toBe("example.com");
    expect(canonicalDomain("https://www.shop.example.com")).toBe("example.com");
  });

  it("does not merge tenants hosted on a shared platform domain", () => {
    // These hosts serve independent organisations from subdomains. Collapsing
    // either to github.io/vercel.sh would make unrelated companies merge.
    expect(canonicalDomain("https://ebookfoundation.github.io")).toBe(
      "ebookfoundation.github.io",
    );
    expect(canonicalDomain("https://release-auth.vercel.sh")).toBe(
      "release-auth.vercel.sh",
    );
    expect(canonicalDomain("https://avatar.vercel.sh")).toBe(
      "avatar.vercel.sh",
    );
  });

  it("rejects inputs that cannot identify a business", () => {
    for (const input of [
      null,
      undefined,
      "",
      "   ",
      "localhost",
      "192.168.0.1",
      "http://10.0.0.5:3000",
      "not a url at all!!",
    ]) {
      expect(canonicalDomain(input)).toBeNull();
    }
  });

  it("is idempotent", () => {
    const once = canonicalDomain("https://WWW.Example.CO.UK/x");
    expect(canonicalDomain(once)).toBe(once);
  });
});

describe("canonicalCompanyName", () => {
  it("strips legal suffixes", () => {
    expect(canonicalCompanyName("Saraswati Dental Care Pvt. Ltd.")).toBe(
      "saraswati dental care",
    );
    expect(canonicalCompanyName("Northline Logistics Limited")).toBe(
      "northline logistics",
    );
    expect(canonicalCompanyName("Acme Inc")).toBe("acme");
    expect(canonicalCompanyName("Müller GmbH")).toBe("muller");
  });

  it("strips stacked suffixes", () => {
    expect(canonicalCompanyName("Acme Holdings Ltd")).toBe("acme");
  });

  it("normalises accents, punctuation and ampersands", () => {
    expect(canonicalCompanyName("Café Münster")).toBe("cafe munster");
    expect(canonicalCompanyName("Harbour & Co")).toBe("harbour and");
    expect(canonicalCompanyName("Harbour and Co")).toBe("harbour and");
  });

  it("collapses whitespace and case differences to one key", () => {
    expect(canonicalCompanyName("  ACME   Design  Studio ")).toBe(
      "acme design studio",
    );
    expect(canonicalCompanyName("Acme Design Studio")).toBe(
      "acme design studio",
    );
  });

  it("never reduces a name to nothing", () => {
    // A company literally called "Limited" must keep its only word.
    expect(canonicalCompanyName("Limited")).toBe("limited");
    expect(canonicalCompanyName("!!!")).toBeNull();
    expect(canonicalCompanyName("")).toBeNull();
    expect(canonicalCompanyName(null)).toBeNull();
  });

  it("is idempotent", () => {
    const once = canonicalCompanyName("Saraswati Dental Care Pvt. Ltd.");
    expect(canonicalCompanyName(once)).toBe(once);
  });
});

describe("canonicalEmail", () => {
  it("lowercases and trims", () => {
    expect(canonicalEmail("  Meera@Example.COM ")).toBe("meera@example.com");
  });

  it("does not apply provider-specific normalisation", () => {
    // Merging these could merge two different people.
    expect(canonicalEmail("first.last@gmail.com")).toBe("first.last@gmail.com");
    expect(canonicalEmail("user+tag@gmail.com")).toBe("user+tag@gmail.com");
  });

  it("rejects malformed addresses", () => {
    for (const input of ["", "nope", "a@b", "a@@b.com", "a b@c.com", null]) {
      expect(canonicalEmail(input)).toBeNull();
    }
  });
});

describe("canonicalPhone", () => {
  it("reduces formatting to digits", () => {
    expect(canonicalPhone("+91 44 4555 1201")).toBe("+914445551201");
    expect(canonicalPhone("(044) 4555-1201")).toBe("04445551201");
  });

  it("normalises the international 00 prefix to +", () => {
    expect(canonicalPhone("0091 44 4555 1201")).toBe("+914445551201");
  });

  it("rejects numbers outside plausible length", () => {
    expect(canonicalPhone("12345")).toBeNull();
    expect(canonicalPhone("1234567890123456789")).toBeNull();
    expect(canonicalPhone(null)).toBeNull();
  });
});

describe("canonicalUrl", () => {
  it("collapses equivalent URLs to one key", () => {
    const expected = "https://example.com";
    expect(canonicalUrl("https://example.com/")).toBe(expected);
    expect(canonicalUrl("https://example.com:443")).toBe(expected);
    expect(canonicalUrl("https://EXAMPLE.com/#section")).toBe(expected);
  });

  it("drops www so it agrees with canonicalDomain", () => {
    // If these disagreed, the same page fetched via www and non-www would be
    // crawled twice and could split one company into two records.
    expect(canonicalUrl("https://www.example.com/about")).toBe(
      "https://example.com/about",
    );
    expect(canonicalUrl("https://www.example.com")).toBe("https://example.com");

    const url = canonicalUrl("https://www.example.com/x");
    expect(canonicalDomain(url)).toBe("example.com");
  });

  it("removes tracking parameters but keeps real ones", () => {
    expect(canonicalUrl("https://example.com/p?utm_source=x&id=7")).toBe(
      "https://example.com/p?id=7",
    );
    expect(canonicalUrl("https://example.com/p?fbclid=abc")).toBe(
      "https://example.com/p",
    );
  });

  it("sorts query parameters so order does not matter", () => {
    expect(canonicalUrl("https://example.com/p?b=2&a=1")).toBe(
      canonicalUrl("https://example.com/p?a=1&b=2"),
    );
  });

  it("rejects non-http schemes", () => {
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalUrl("mailto:a@b.com")).toBeNull();
    expect(canonicalUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("canonicalPersonName", () => {
  it("strips honorifics and credentials", () => {
    expect(canonicalPersonName("Dr. Meera Iyer")).toBe("meera iyer");
    expect(canonicalPersonName("Dr. Meera Iyer, BDS")).toBe("meera iyer");
    expect(canonicalPersonName("Mr Arun Prasad")).toBe("arun prasad");
  });

  it("keeps a single-word name that looks like an honorific", () => {
    expect(canonicalPersonName("Dr")).toBe("dr");
  });

  it("normalises accents and spacing", () => {
    expect(canonicalPersonName("  José   Álvarez ")).toBe("jose alvarez");
  });

  it("returns null for unusable input", () => {
    expect(canonicalPersonName("")).toBeNull();
    expect(canonicalPersonName(null)).toBeNull();
  });
});

describe("scheme rejection (regression)", () => {
  /**
   * `mailto:` and `javascript:` have no "//", so an implementation that
   * blindly prepends a scheme turns them into a parseable but bogus URL
   * (`https://mailto:a@b.com`). Both helpers must reject them outright.
   */
  it.each([
    "mailto:a@b.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com",
  ])("rejects %s in both canonicalisers", (input) => {
    expect(canonicalUrl(input)).toBeNull();
    expect(canonicalDomain(input)).toBeNull();
  });
});
