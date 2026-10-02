/**
 * Soft in-memory sliding-window rate limiter for POST /callback.
 * High ceiling by default so normal dual-deliver traffic never trips;
 * 429 + Retry-After only on abuse.
 */

import { createHash } from "node:crypto";

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest in-window hit expires (0 when allowed). */
  retryAfterSec: number;
  /** Hits remaining in the current window after this check (0 when denied). */
  remaining: number;
  /** Hits counted in the window after this check (including when denied). */
  count: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs: number = 60_000,
  ) {
    if (!Number.isFinite(limitPerWindow) || limitPerWindow < 0) {
      throw new Error("limitPerWindow must be a non-negative number");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive number");
    }
  }

  /** When limit is 0, every check is allowed (rate limit disabled). */
  get enabled(): boolean {
    return this.limitPerWindow > 0;
  }

  get limit(): number {
    return this.limitPerWindow;
  }

  check(
    key: string,
    now = Date.now(),
    opts?: { record?: boolean },
  ): RateLimitResult {
    if (!this.enabled) {
      return { allowed: true, retryAfterSec: 0, remaining: Infinity, count: 0 };
    }

    const record = opts?.record !== false;
    const cutoff = now - this.windowMs;
    let stamps = this.hits.get(key);
    if (!stamps) {
      stamps = [];
      this.hits.set(key, stamps);
    } else {
      let i = 0;
      while (i < stamps.length && stamps[i]! < cutoff) i++;
      if (i > 0) stamps.splice(0, i);
    }

    if (stamps.length >= this.limitPerWindow) {
      const oldest = stamps[0]!;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - now) / 1000),
      );
      return {
        allowed: false,
        retryAfterSec,
        remaining: 0,
        count: stamps.length,
      };
    }

    if (record) stamps.push(now);
    const count = stamps.length + (record ? 0 : 1);
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: this.limitPerWindow - (record ? stamps.length : count),
      count: record ? stamps.length : count,
    };
  }

  /** Test helper — clear all buckets. */
  reset(): void {
    this.hits.clear();
  }

  /** Approximate live key count (for diagnostics / tests). */
  size(): number {
    return this.hits.size;
  }
}

/** Stable short hash of a secret (never log the raw token). */
export function hashIdentity(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
