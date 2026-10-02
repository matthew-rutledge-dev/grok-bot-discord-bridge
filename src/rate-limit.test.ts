import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlidingWindowRateLimiter, hashIdentity } from "./rate-limit.js";

describe("SlidingWindowRateLimiter", () => {
  it("allows up to limit then denies with retryAfter", () => {
    const lim = new SlidingWindowRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    assert.equal(lim.check("a", t0).allowed, true);
    assert.equal(lim.check("a", t0 + 1).allowed, true);
    assert.equal(lim.check("a", t0 + 2).allowed, true);
    const denied = lim.check("a", t0 + 3);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSec >= 1);
    assert.equal(denied.remaining, 0);
  });

  it("peek (record:false) does not consume quota", () => {
    const lim = new SlidingWindowRateLimiter(1, 60_000);
    const t0 = 2_000_000;
    const peek = lim.check("b", t0, { record: false });
    assert.equal(peek.allowed, true);
    assert.equal(lim.check("b", t0).allowed, true);
    assert.equal(lim.check("b", t0 + 1).allowed, false);
  });

  it("window expiry frees capacity", () => {
    const lim = new SlidingWindowRateLimiter(2, 1000);
    const t0 = 3_000_000;
    assert.equal(lim.check("c", t0).allowed, true);
    assert.equal(lim.check("c", t0 + 100).allowed, true);
    assert.equal(lim.check("c", t0 + 200).allowed, false);
    assert.equal(lim.check("c", t0 + 1100).allowed, true);
  });

  it("keys are independent", () => {
    const lim = new SlidingWindowRateLimiter(1, 60_000);
    const t0 = 4_000_000;
    assert.equal(lim.check("x", t0).allowed, true);
    assert.equal(lim.check("y", t0).allowed, true);
    assert.equal(lim.check("x", t0 + 1).allowed, false);
    assert.equal(lim.check("y", t0 + 1).allowed, false);
  });

  it("limit 0 disables enforcement", () => {
    const lim = new SlidingWindowRateLimiter(0, 60_000);
    assert.equal(lim.enabled, false);
    for (let i = 0; i < 50; i++) {
      assert.equal(lim.check("z", 5_000_000 + i).allowed, true);
    }
  });

  it("hashIdentity is stable and short", () => {
    const a = hashIdentity("secret-token");
    const b = hashIdentity("secret-token");
    const c = hashIdentity("other");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 16);
    assert.doesNotMatch(a, /secret/);
  });
});
