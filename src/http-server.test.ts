import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpServer,
  extractCallbackAuth,
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
  it("prefers Bearer over x-callback-token", () => {
    const req = {
      header: (n: string) => {
        const k = n.toLowerCase();
        if (k === "authorization") return "Bearer abc";
        if (k === "x-callback-token") return "hdr";
        return undefined;
      },
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

  it("ignores ?token= query (header-only as of 0.2.4)", () => {
    const req = {
      header: () => undefined,
      query: { token: "qtok" },
    } as unknown as import("express").Request;
    const r = extractCallbackAuth(req);
    assert.equal(r.token, undefined);
    assert.equal(r.source, undefined);
  });
});

describe("POST /callback auth + soft rate limit", () => {
  let server: Server;
  let base: string;
  const limiter = new SlidingWindowRateLimiter(5, 60_000);

  before(async () => {
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

  it("rejects ?token= query alone with 401", async () => {
    const res = await fetch(
      `${base}/callback?token=test-callback-token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: "1", content: "hello" }),
      },
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  it("rejects wrong Bearer with 401", async () => {
    const res = await fetch(`${base}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ channelId: "1", content: "hello" }),
    });
    assert.equal(res.status, 401);
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

describe("POST /callback edits a planner working message", () => {
  let server: Server;
  let base: string;
  const edits: { id: string; payload: { content?: string; files?: unknown[] } }[] = [];
  const sends: unknown[] = [];
  let failEdit = false;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  before(async () => {
    const discord = {
      isReady: () => true,
      channels: {
        fetch: async (channelId: string) => ({
          id: channelId,
          isTextBased: () => true,
          send: async (payload: unknown) => {
            sends.push(payload);
            return { id: "sent-1" };
          },
          messages: {
            fetch: async (id: string) => {
              if (failEdit) throw new Error("missing");
              return {
                id,
                edit: async (payload: { content?: string; files?: unknown[] }) => {
                  edits.push({ id, payload });
                  return { id };
                },
              };
            },
          },
        }),
      },
    };
    const app = createHttpServer(
      mockCfg(),
      () => discord as unknown as import("discord.js").Client,
      { rateLimiter: new SlidingWindowRateLimiter(0) },
    );
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

  async function post(body: Record<string, unknown>, headers?: Record<string, string>) {
    return fetch(`${base}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-callback-token",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("edits the remembered working message for replyToMessageId", async () => {
    edits.length = 0;
    sends.length = 0;
    failEdit = false;
    const { rememberPlannerStatus, lookupPlannerStatus } = await import("./local-planner.js");
    rememberPlannerStatus("1555776603705835603", {
      channelId: "42",
      statusMessageId: "9001",
    });
    const res = await post({
      channelId: "42",
      content: "",
      replyToMessageId: "1555776603705835603",
      attachments: [{ filename: "1x1.png", contentType: "image/png", data: png }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; edited?: boolean; messageId: string };
    assert.equal(body.ok, true);
    assert.equal(body.edited, true);
    assert.equal(body.messageId, "9001");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].id, "9001");
    assert.equal(edits[0].payload.content, "");
    assert.equal(edits[0].payload.files?.length, 1);
    assert.equal(sends.length, 0);
    assert.equal(lookupPlannerStatus("1555776603705835603"), undefined);
  });

  it("edits statusMessageId from the callback body", async () => {
    edits.length = 0;
    sends.length = 0;
    failEdit = false;
    const res = await post({
      channelId: "42",
      content: "Couldn't finish that.",
      replyToMessageId: "1555776603705835603",
      statusMessageId: "9002",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { edited?: boolean; messageId: string };
    assert.equal(body.edited, true);
    assert.equal(body.messageId, "9002");
    assert.equal(edits[0].payload.content, "Couldn't finish that.");
    assert.equal(sends.length, 0);
  });

  it("sends a new message when there is no working message", async () => {
    edits.length = 0;
    sends.length = 0;
    failEdit = false;
    const res = await post({
      channelId: "42",
      content: "plain callback",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { edited?: boolean; messageId: string };
    assert.equal(body.edited, undefined);
    assert.equal(body.messageId, "sent-1");
    assert.equal(edits.length, 0);
    assert.equal(sends.length, 1);
  });

  it("falls back to a new message when the edit fails", async () => {
    edits.length = 0;
    sends.length = 0;
    failEdit = true;
    const res = await post({
      channelId: "42",
      content: "image later",
      statusMessageId: "9003",
    });
    failEdit = false;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { edited?: boolean; messageId: string };
    assert.equal(body.edited, undefined);
    assert.equal(body.messageId, "sent-1");
    assert.equal(sends.length, 1);
  });

  it("accepts x-callback-token when editing", async () => {
    edits.length = 0;
    const res = await post(
      { channelId: "42", content: "header auth", statusMessageId: "9004" },
      { authorization: "", "x-callback-token": "test-callback-token" },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { edited?: boolean };
    assert.equal(body.edited, true);
  });
});
