import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  clearQueryTokenWarnState,
  createHttpServer,
  extractCallbackAuth,
  warnQueryTokenAuth,
} from "./http-server.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import type { AppConfig } from "./config.js";

function mockCfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "",
    hasRealDiscordToken: false,
    guildId: "",
    allowFrom: [],
    allowRoles: [],
    allowChannels: [],
    ownerId: "",
    dmPolicy: "disabled",
    sendPromptUrl: "http://127.0.0.1:9/api/sendPrompt",
    gatewayToken: "gw",
    callbackToken: "test-callback-token",
    callbackRateLimitPerMin: 90,
    callbackPath: "/callback",
    callbackBaseUrl: "http://127.0.0.1:18083",
    httpBind: "127.0.0.1",
    httpPort: 0,
    channelMapPath: "./config/channel-map.json",
    securityPath: "./config/security.json",
    requireMentionDefault: true,
    httpOnly: true,
    channelMap: { version: 1, channels: [] },
    security: {
      version: 1,
      ignoreBots: true,
      guilds: {},
      dm: { policy: "disabled", allowFrom: [] },
    },
    ...overrides,
  } as AppConfig;
}

describe("extractCallbackAuth", () => {
  it("prefers Bearer over query", () => {
    const req = {
      header: (n: string) =>
        n.toLowerCase() === "authorization" ? "Bearer abc" : undefined,
      query: { token: "from-query" },
    } as unknown as import("express").Request;
    const r = extractCallbackAuth(req);
    assert.equal(r.token, "abc");
    assert.equal(r.source, "bearer");
  });

  it("uses x-callback-token when no Bearer", () => {
    const req = {
      header: (n: string) =>
        n.toLowerCase() === "x-callback-token" ? "hdr" : undefined,
      query: {},
    } as unknown as import("express").Request;
    const r = extractCallbackAuth(req);
    assert.equal(r.token, "hdr");
    assert.equal(r.source, "header");
  });

  it("falls back to ?token=", () => {
    const req = {
      header: () => undefined,
      query: { token: "qtok" },
    } as unknown as import("express").Request;
    const r = extractCallbackAuth(req);
    assert.equal(r.token, "qtok");
    assert.equal(r.source, "query");
  });
});

describe("warnQueryTokenAuth", () => {
  it("warns once then throttles per identity", () => {
    clearQueryTokenWarnState();
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      assert.equal(warnQueryTokenAuth("id1", 1000), true);
      assert.equal(warnQueryTokenAuth("id1", 2000), false);
      assert.equal(warnQueryTokenAuth("id1", 1000 + 15 * 60 * 1000), true);
      assert.equal(warnQueryTokenAuth("id2", 1000), true);
    } finally {
      console.warn = orig;
    }
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /\?token=/);
    assert.match(lines[0]!, /Bearer|x-callback-token/);
  });
});

describe("POST /callback auth + soft rate limit", () => {
  let server: Server;
  let base: string;
  const limiter = new SlidingWindowRateLimiter(5, 60_000);

  before(async () => {
    clearQueryTokenWarnState();
    limiter.reset();
    const app = createHttpServer(mockCfg(), () => null, {
      rateLimiter: limiter,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("rejects missing auth with 401", async () => {
    const res = await fetch(`${base}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "1", content: "x" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  it("accepts Authorization Bearer (passes auth; discord may 503)", async () => {
    const res = await fetch(`${base}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-callback-token",
      },
      body: JSON.stringify({ channelId: "1", content: "hello" }),
    });
    // Auth ok; discord not ready in this harness
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 429);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "discord_not_ready");
  });

  it("accepts x-callback-token header", async () => {
    const res = await fetch(`${base}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-callback-token": "test-callback-token",
      },
      body: JSON.stringify({ channelId: "1", content: "hello" }),
    });
    assert.equal(res.status, 503);
  });

  it("still accepts ?token= query (deprecated path)", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    try {
      clearQueryTokenWarnState();
      const res = await fetch(
        `${base}/callback?token=test-callback-token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: "1", content: "hello" }),
        },
      );
      assert.equal(res.status, 503);
      assert.ok(warns.some((w) => w.includes("?token=")));
    } finally {
      console.warn = orig;
    }
  });

  it("trips soft rate limit with 429 + Retry-After", async () => {
    limiter.reset();
    // limit is 5; burn 5 authed requests then expect 429
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-callback-token",
        },
        body: JSON.stringify({ channelId: "1", content: `n${i}` }),
      });
      assert.notEqual(res.status, 429, `request ${i} should not 429`);
      assert.notEqual(res.status, 401);
    }
    const res = await fetch(`${base}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-callback-token",
      },
      body: JSON.stringify({ channelId: "1", content: "overflow" }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"));
    const body = (await res.json()) as { error: string; retryAfterSec: number };
    assert.equal(body.error, "rate_limited");
    assert.ok(body.retryAfterSec >= 1);
  });
});
