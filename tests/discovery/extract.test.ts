import { describe, expect, it } from "vitest";

import {
  extractFacts,
  extractJsonLd,
  extractLanguage,
  extractMetaTags,
  extractSitemapUrls,
  extractTitle,
  isSitemapIndex,
  stripTags,
} from "@/lib/discovery/extract";

const URL = "https://example.test/";

describe("stripTags", () => {
  it("removes markup, scripts and styles", () => {
    expect(
      stripTags("<p>Hello <b>world</b></p><script>evil()</script><style>x{}</style>"),
    ).toBe("Hello world");
  });

  it("decodes common entities", () => {
    expect(stripTags("Tom &amp; Jerry&nbsp;Ltd")).toBe("Tom & Jerry Ltd");
  });
});

describe("extractTitle", () => {
  it("reads the title", () => {
    expect(extractTitle("<html><head><title>  Acme  </title></head></html>")).toBe(
      "Acme",
    );
  });

  it("returns null when absent or empty", () => {
    expect(extractTitle("<html></html>")).toBeNull();
    expect(extractTitle("<title></title>")).toBeNull();
  });
});

describe("extractMetaTags", () => {
  it("handles either attribute order", () => {
    const tags = extractMetaTags(`
      <meta name="description" content="A description">
      <meta content="Acme" property="og:site_name">
    `);

    expect(tags.get("description")).toBe("A description");
    expect(tags.get("og:site_name")).toBe("Acme");
  });

  it("keeps the first occurrence of a duplicated tag", () => {
    const tags = extractMetaTags(`
      <meta name="description" content="first">
      <meta name="description" content="second">
    `);

    expect(tags.get("description")).toBe("first");
  });
});

describe("extractJsonLd", () => {
  it("parses a valid block", () => {
    const blocks = extractJsonLd(
      `<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>`,
    );

    expect(blocks).toEqual([{ "@type": "Organization", name: "Acme" }]);
  });

  it("skips malformed JSON without losing valid blocks", () => {
    const blocks = extractJsonLd(`
      <script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">{"@type":"Organization","name":"Good"}</script>
    `);

    expect(blocks).toHaveLength(1);
  });

  it("never executes script content", () => {
    // A JSON-LD block containing what looks like code is parsed as data only.
    const blocks = extractJsonLd(
      `<script type="application/ld+json">{"name":"process.exit(1)"}</script>`,
    );

    expect(blocks).toEqual([{ name: "process.exit(1)" }]);
  });

  it("ignores ordinary scripts", () => {
    expect(extractJsonLd(`<script>var x = {"name":"Acme"};</script>`)).toEqual([]);
  });
});

describe("extractFacts", () => {
  it("prefers JSON-LD over meta tags over markup", () => {
    const facts = extractFacts({
      url: URL,
      html: `<html>
        <head>
          <title>Title Name</title>
          <meta property="og:site_name" content="Meta Name">
          <script type="application/ld+json">
            {"@type":"Organization","name":"Structured Name"}
          </script>
        </head>
      </html>`,
    });

    const name = facts.find((f) => f.field === "name");
    expect(name?.value).toBe("Structured Name");
    expect(name?.method).toBe("STRUCTURED_DATA");
  });

  it("reads a nested @graph", () => {
    const facts = extractFacts({
      url: URL,
      html: `<script type="application/ld+json">
        {"@graph":[{"@type":"WebPage"},{"@type":"LocalBusiness","name":"Graph Co"}]}
      </script>`,
    });

    expect(facts.find((f) => f.field === "name")?.value).toBe("Graph Co");
  });

  it("classifies social links by platform", () => {
    const facts = extractFacts({
      url: URL,
      html: `<script type="application/ld+json">
        {"@type":"Organization","name":"S","sameAs":[
          "https://linkedin.com/company/s",
          "https://instagram.com/s",
          "https://facebook.com/s",
          "https://youtube.com/@s"
        ]}
      </script>`,
    });

    const byField = new Map(facts.map((f) => [f.field, f.value]));
    expect(byField.get("linkedinUrl")).toContain("linkedin.com");
    expect(byField.get("instagramUrl")).toContain("instagram.com");
    expect(byField.get("facebookUrl")).toContain("facebook.com");
    expect(byField.get("youtubeUrl")).toContain("youtube.com");
  });

  it("ignores non-business structured data", () => {
    const facts = extractFacts({
      url: URL,
      html: `<script type="application/ld+json">
        {"@type":"Article","name":"An article about Acme"}
      </script>`,
    });

    // An article's name is not a company name.
    expect(facts.find((f) => f.field === "name")).toBeUndefined();
  });

  it("emits one fact per field", () => {
    const facts = extractFacts({
      url: URL,
      html: `<html><head><title>T</title>
        <meta property="og:site_name" content="M">
      </head><body>
        <a href="mailto:a@x.test">a</a><a href="mailto:b@x.test">b</a>
      </body></html>`,
    });

    const fields = facts.map((f) => f.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("attaches provenance to every fact", () => {
    const facts = extractFacts({
      url: URL,
      html: `<html><head><title>Acme</title></head></html>`,
    });

    for (const fact of facts) {
      expect(fact.sourceUrl).toBe(URL);
      expect(fact.locator).toBeTruthy();
      expect(fact.method).toBeTruthy();
    }
  });

  it("extracts nothing from an empty or junk document", () => {
    expect(extractFacts({ url: URL, html: "" })).toEqual([]);
    expect(extractFacts({ url: URL, html: "just some text" })).toEqual([]);
  });

  it("does not invent data that is not present", () => {
    const facts = extractFacts({
      url: URL,
      html: `<html><head><title>Acme</title></head><body>No contact details here.</body></html>`,
    });

    expect(facts.find((f) => f.field === "email")).toBeUndefined();
    expect(facts.find((f) => f.field === "phone")).toBeUndefined();
    expect(facts.find((f) => f.field === "city")).toBeUndefined();
  });
});

describe("extractLanguage", () => {
  it("reads the html lang attribute", () => {
    expect(extractLanguage(`<html lang="en-GB">`)).toBe("en-gb");
    expect(extractLanguage(`<html>`)).toBeNull();
  });
});

describe("sitemaps", () => {
  it("extracts locations", () => {
    expect(
      extractSitemapUrls(`<urlset>
        <url><loc>https://a.test/1</loc></url>
        <url><loc>https://a.test/2</loc></url>
      </urlset>`),
    ).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("detects a sitemap index", () => {
    expect(isSitemapIndex(`<sitemapindex><sitemap></sitemap></sitemapindex>`)).toBe(
      true,
    );
    expect(isSitemapIndex(`<urlset></urlset>`)).toBe(false);
  });

  it("returns nothing for junk input", () => {
    expect(extractSitemapUrls("not xml")).toEqual([]);
  });
});
