import "server-only";

export interface RateLimiter {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): { ok: true } | { ok: false; retryAfter: number };
}

class InMemoryRateLimiter implements RateLimiter {
  private entries = new Map<
    string,
    { count: number; expires: number }
  >();

  consume(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const current = this.entries.get(key);

    if (!current || current.expires <= now) {
      this.entries.set(key, {
        count: 1,
        expires: now + windowMs,
      });

      return { ok: true } as const;
    }

    if (current.count >= limit) {
      return {
        ok: false,
        retryAfter: Math.ceil(
          (current.expires - now) / 1000,
        ),
      } as const;
    }

    current.count++;

    return { ok: true } as const;
  }
}

export const rateLimiter: RateLimiter =
  new InMemoryRateLimiter();
