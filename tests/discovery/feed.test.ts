import { describe, expect, it } from "vitest";

import { isFeed, parseFeed, parseFeedDate } from "@/lib/discovery/feed";

describe("parseFeedDate", () => {
  it("reads RSS and Atom date formats", () => {
    expect(parseFeedDate("Mon, 01 Sep 2026 10:00:00 GMT")?.getUTCFullYear()).toBe(2026);
    expect(parseFeedDate("2026-09-01T10:00:00Z")?.getUTCMonth()).toBe(8);
  });

  it("returns null rather than guessing at an unreadable date", () => {
    // Defaulting to "now" would corrupt every freshness decision downstream.
    expect(parseFeedDate("not a date")).toBeNull();
    expect(parseFeedDate("")).toBeNull();
    expect(parseFeedDate(null)).toBeNull();
  });

  it("rejects absurd years", () => {
    expect(parseFeedDate("3999-01-01T00:00:00Z")).toBeNull();
    expect(parseFeedDate("1200-01-01T00:00:00Z")).toBeNull();
  });
});

describe("isFeed", () => {
  it("recognises RSS and Atom", () => {
    expect(isFeed('<rss version="2.0"><channel/></rss>')).toBe(true);
    expect(isFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toBe(true);
    expect(isFeed("<html><body>not a feed</body></html>")).toBe(false);
  });
});

describe("parseFeed — RSS", () => {
  const RSS = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Business News</title>
      <link>https://news.test</link>
      <item>
        <title>Acme opens a clinic</title>
        <link>https://acme.test/news</link>
        <description>A short summary.</description>
        <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
        <category>Health</category>
        <category>Local</category>
      </item>
      <item>
        <title><![CDATA[Beta & Co expands]]></title>
        <link>https://beta.test</link>
      </item>
    </channel></rss>`;

  it("reads channel metadata and items", () => {
    const feed = parseFeed(RSS);

    expect(feed.title).toBe("Business News");
    expect(feed.siteUrl).toBe("https://news.test");
    expect(feed.items).toHaveLength(2);
  });

  it("reads item fields", () => {
    const [first] = parseFeed(RSS).items;

    expect(first.title).toBe("Acme opens a clinic");
    expect(first.link).toBe("https://acme.test/news");
    expect(first.summary).toBe("A short summary.");
    expect(first.publishedAt?.getUTCFullYear()).toBe(2026);
    expect(first.categories).toEqual(["Health", "Local"]);
  });

  it("unwraps CDATA and decodes entities", () => {
    expect(parseFeed(RSS).items[1].title).toBe("Beta & Co expands");
  });

  it("leaves a missing date null", () => {
    expect(parseFeed(RSS).items[1].publishedAt).toBeNull();
  });
});

describe("parseFeed — Atom", () => {
  const ATOM = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom News</title>
      <link rel="self" href="https://atom.test/feed"/>
      <link rel="alternate" href="https://atom.test"/>
      <entry>
        <title>Gamma launches</title>
        <link rel="alternate" href="https://gamma.test/post"/>
        <summary>Summary text.</summary>
        <published>2026-09-01T10:00:00Z</published>
        <category term="Launch"/>
      </entry>
    </feed>`;

  it("prefers the alternate link over rel=self", () => {
    const feed = parseFeed(ATOM);

    expect(feed.items[0].link).toBe("https://gamma.test/post");
    expect(feed.siteUrl).toBe("https://atom.test");
  });

  it("reads entry fields", () => {
    const [entry] = parseFeed(ATOM).items;

    expect(entry.title).toBe("Gamma launches");
    expect(entry.summary).toBe("Summary text.");
    expect(entry.publishedAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(entry.categories).toEqual(["Launch"]);
  });
});

describe("parseFeed — hostile and malformed input", () => {
  it("never throws on junk", () => {
    for (const input of ["", "<rss>", "not xml at all", "<feed><entry>"]) {
      expect(() => parseFeed(input)).not.toThrow();
    }
  });

  it("returns the items it could read from a partly broken feed", () => {
    const feed = parseFeed(`<rss><channel>
      <item><title>Good</title><link>https://a.test</link></item>
      <item><title>Unclosed
    </channel></rss>`);

    expect(feed.items.length).toBeGreaterThanOrEqual(1);
    expect(feed.items[0].title).toBe("Good");
  });

  it("does not resolve external entities", () => {
    // A regex reader cannot expand an entity, which is exactly why one is used
    // here: XXE and entity-expansion attacks are structurally impossible.
    const xxe = `<?xml version="1.0"?>
      <!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <rss><channel><item><title>&xxe;</title><link>https://a.test</link></item></channel></rss>`;

    const feed = parseFeed(xxe);

    expect(feed.items[0].title).not.toContain("root:");
  });

  it("caps the number of items from one feed", () => {
    const items = Array.from(
      { length: 500 },
      (_, i) => `<item><title>t${i}</title><link>https://a.test/${i}</link></item>`,
    ).join("");

    expect(parseFeed(`<rss><channel>${items}</channel></rss>`).items.length).toBe(200);
  });

  it("strips markup from titles", () => {
    const feed = parseFeed(
      `<rss><channel><item><title>A &lt;b&gt;bold&lt;/b&gt; title</title></item></channel></rss>`,
    );

    expect(feed.items[0].title).toBe("A <b>bold</b> title");
  });
});
