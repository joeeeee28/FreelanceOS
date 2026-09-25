import { describe, expect, it } from "vitest";

import { checkTarget, describeBlock } from "@/lib/discovery/net-guard";

describe("checkTarget: public destinations are allowed", () => {
  for (const url of [
    "https://example.com/",
    "http://example.co.uk/path?q=1",
    "https://sub.domain.example.org/a/b",
    "https://8.8.8.8/",
    "https://1.1.1.1/dns-query",
  ]) {
    it(`allows ${url}`, () => {
      expect(checkTarget(url).allowed).toBe(true);
    });
  }
});

describe("checkTarget: loopback", () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/x",
    "http://127.1.2.3/",
    "https://localhost/",
    "http://[::1]:3000/",
    "http://LOCALHOST/",
  ]) {
    it(`blocks ${url}`, () => {
      const result = checkTarget(url);
      expect(result.allowed).toBe(false);
      expect(["loopback", "non-public-hostname"]).toContain(result.reason);
    });
  }

  it("allows loopback only when explicitly opted in", () => {
    expect(checkTarget("http://127.0.0.1:9/", { allowLoopback: true }).allowed).toBe(
      true,
    );
    expect(checkTarget("http://localhost:9/", { allowLoopback: true }).allowed).toBe(
      true,
    );
  });

  it("still blocks the metadata address even with the test opt-in", () => {
    // The escape hatch must not be wide enough to reach the one address that
    // hands out cloud credentials.
    const result = checkTarget("http://169.254.169.254/", { allowLoopback: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("cloud-metadata");
  });

  it("still blocks private networks with the test opt-in", () => {
    expect(
      checkTarget("http://10.1.2.3/", { allowLoopback: true }).allowed,
    ).toBe(false);
  });
});

describe("checkTarget: private and reserved ranges", () => {
  const cases: Array<[string, string]> = [
    ["http://10.0.0.1/", "private-network"],
    ["http://172.16.5.5/", "private-network"],
    ["http://172.31.255.255/", "private-network"],
    ["http://192.168.0.1/", "private-network"],
    ["http://100.64.0.1/", "private-network"],
    ["http://169.254.1.1/", "link-local"],
    ["http://169.254.169.254/latest/meta-data/", "cloud-metadata"],
    ["http://0.0.0.0/", "unspecified-address"],
    ["http://[fd00::1]/", "private-network"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[::]/", "unspecified-address"],
  ];

  for (const [url, reason] of cases) {
    it(`blocks ${url} as ${reason}`, () => {
      const result = checkTarget(url);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(reason);
    });
  }

  it("does not block a public address that merely starts with a private octet", () => {
    // 172.32.x is outside 172.16/12 and is public.
    expect(checkTarget("http://172.32.0.1/").allowed).toBe(true);
    expect(checkTarget("http://11.0.0.1/").allowed).toBe(true);
  });
});

describe("checkTarget: encoded and alternate forms", () => {
  it("blocks the decimal-integer form of 127.0.0.1", () => {
    // 2130706433 === 0x7f000001. A dotted-quad-only guard misses this.
    const result = checkTarget("http://2130706433/");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("loopback");
  });

  it("blocks IPv4-mapped IPv6 loopback", () => {
    expect(checkTarget("http://[::ffff:127.0.0.1]/").allowed).toBe(false);
  });

  it("blocks a trailing-dot loopback hostname", () => {
    expect(checkTarget("http://localhost./").allowed).toBe(false);
  });
});

describe("checkTarget: hostnames", () => {
  for (const url of [
    "http://metadata.google.internal/",
    "http://something.internal/",
    "http://printer.local/",
    "http://app.localhost/",
    "http://intranet/",
    "http://internal-service/",
  ]) {
    it(`blocks ${url}`, () => {
      expect(checkTarget(url).allowed).toBe(false);
    });
  }
});

describe("checkTarget: schemes and malformed input", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "data:text/html,hi",
    "javascript:alert(1)",
  ]) {
    it(`blocks ${url}`, () => {
      const result = checkTarget(url);
      expect(result.allowed).toBe(false);
    });
  }

  it("blocks malformed input", () => {
    expect(checkTarget("not a url").allowed).toBe(false);
    expect(checkTarget("").allowed).toBe(false);
  });
});

describe("describeBlock", () => {
  it("names the metadata address specifically", () => {
    const result = checkTarget("http://169.254.169.254/");
    expect(describeBlock(result)).toContain("metadata");
  });

  it("produces a readable reason for each block", () => {
    for (const url of ["http://127.0.0.1/", "http://10.0.0.1/", "file:///x"]) {
      expect(describeBlock(checkTarget(url)).length).toBeGreaterThan(0);
    }
  });
});
