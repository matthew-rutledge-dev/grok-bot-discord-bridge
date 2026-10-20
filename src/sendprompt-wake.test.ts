import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SendPromptHttpError } from "./grok-client.js";
import { SendPromptHoldQueue, type HoldInput, type HoldUi } from "./sendprompt-hold.js";
import {
  SendPromptWakeHook,
  wakeAuthHeader,
  wakeReason,
  type WakeHookOptions,
} from "./sendprompt-wake.js";
import type { SendPromptResponse } from "./types.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const WAKE_URL = "https://wake.example.test/hooks/routine-secret-path";
const WAKE_KEY = "wake-key-SHOULD-NEVER-LEAK";
const GATEWAY_TOKEN = "gateway-token-SHOULD-NEVER-LEAK";
const SECRET_PROMPT = "my private message text";

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: () => Promise<Response> = async () => new Response("ok", { status: 200 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function recordingLog() {
  const lines: string[] = [];
  return { lines, log: { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) } };
}

function hook(extra: Partial<WakeHookOptions> = {}) {
  const f = recordingFetch();
  const l = recordingLog();
  const wake = new SendPromptWakeHook({ url: WAKE_URL, key: WAKE_KEY, fetchImpl: f.fetchImpl, log: l.log, ...extra });
  return { wake, calls: f.calls, lines: l.lines };
}

const ui: HoldUi = {
  async holding() {
    return "s1";
  },
  async delivered() {},
  async failed() {},
};

const quiet = { info: () => undefined, warn: () => undefined };
const ok: SendPromptResponse = { accepted: true };
const tunnelDown = () =>
  new SendPromptHttpError("sendPrompt non-JSON response HTTP 530 body=error code: 1033", 530, "error code: 1033");

function input(messageId: string, channelId = "c1"): HoldInput {
  return {
    messageId,
    channelId,
    hop: `d:secret-channel-name:${messageId}`,
    sendUrl: "http://127.0.0.1:9/api/sendPrompt",
    request: { agentId: "agent-SECRET-ID", prompt: SECRET_PROMPT, metadata: { u: "123456789012345678" } } as HoldInput["request"],
  };
}

describe("wakeReason / wakeAuthHeader", () => {
  it("gives short content-free codes", () => {
    assert.equal(wakeReason(tunnelDown()), "tunnel_1033");
    assert.equal(wakeReason(new SendPromptHttpError("sendPrompt HTTP 530: x", 530, "")), "http_530");
    assert.equal(wakeReason(new Error("sendPrompt HTTP 502: bad gateway " + SECRET_PROMPT)), "http_502");
    assert.equal(wakeReason(new TypeError("fetch failed")), "network");
  });

  it("defaults to Authorization: Bearer and supports a raw custom header", () => {
    assert.deepEqual(wakeAuthHeader(undefined, "k"), { name: "Authorization", value: "Bearer k" });
    assert.deepEqual(wakeAuthHeader("", "k"), { name: "Authorization", value: "Bearer k" });
    assert.deepEqual(wakeAuthHeader("authorization", "k"), { name: "Authorization", value: "Bearer k" });
    assert.deepEqual(wakeAuthHeader("X-Webhook-Key", "k"), { name: "X-Webhook-Key", value: "k" });
    assert.deepEqual(wakeAuthHeader("bad header\n", "k"), { name: "Authorization", value: "Bearer k" });
    assert.equal(wakeAuthHeader("Authorization", ""), undefined);
  });
});

describe("SendPromptWakeHook", () => {
  it("is off when the URL is blank, even with a key", async () => {
    const { wake, calls } = hook({ url: "" });
    assert.equal(wake.enabled, false);
    wake.held({ err: tunnelDown(), heldCount: 1, firstHeldAt: 0 });
    await wake.lastPost;
    assert.equal(calls.length, 0);
    assert.equal(wake.describe(), "[sendPrompt] wake hook off");
  });

  it("is off for a non-http URL and does not log it", () => {
    const { wake, lines } = hook({ url: "file:///etc/routine-secret-path" });
    assert.equal(wake.enabled, false);
    assert.ok(lines.every((l) => !l.includes("routine-secret-path")));
  });

  it("describes itself with the host only", () => {
    const { wake } = hook();
    assert.equal(wake.describe(), "[sendPrompt] wake hook on host=wake.example.test header=Authorization timeoutMs=5000");
  });

  it("sends the key in the configured header", async () => {
    const bearer = hook();
    bearer.wake.held({ err: tunnelDown(), heldCount: 1, firstHeldAt: 0 });
    await bearer.wake.lastPost;
    assert.equal((bearer.calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${WAKE_KEY}`);
    const raw = hook({ header: "X-Webhook-Key" });
    raw.wake.held({ err: tunnelDown(), heldCount: 1, firstHeldAt: 0 });
    await raw.wake.lastPost;
    const h = raw.calls[0].init.headers as Record<string, string>;
    assert.equal(h["X-Webhook-Key"], WAKE_KEY);
    assert.equal(h.Authorization, undefined);
  });

  it("times out a hung wake and logs without the key or URL", async () => {
    const l = recordingLog();
    const fetchImpl = ((_u: string | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
      })) as typeof fetch;
    const wake = new SendPromptWakeHook({ url: WAKE_URL, key: WAKE_KEY, fetchImpl, log: l.log, timeoutMs: 20 });
    // AbortSignal.timeout uses an unref'd timer; keep the test's event loop alive.
    const keepAlive = setInterval(() => undefined, 1_000);
    const started = Date.now();
    wake.held({ err: tunnelDown(), heldCount: 1, firstHeldAt: 0 });
    await wake.lastPost;
    clearInterval(keepAlive);
    assert.ok(Date.now() - started < 2_000);
    const line = l.lines.find((x) => x.includes("wake failed"));
    assert.ok(line, l.lines.join("\n"));
    assert.match(line, /TimeoutError/);
    for (const x of l.lines) {
      assert.ok(!x.includes(WAKE_KEY));
      assert.ok(!x.includes("routine-secret-path"));
    }
  });

  it("logs a non-2xx wake as failed without the key", async () => {
    const f = recordingFetch(async () => new Response(`echo ${WAKE_KEY}`, { status: 401 }));
    const l = recordingLog();
    const wake = new SendPromptWakeHook({ url: WAKE_URL, key: WAKE_KEY, fetchImpl: f.fetchImpl, log: l.log });
    wake.held({ err: tunnelDown(), heldCount: 1, firstHeldAt: 0 });
    await wake.lastPost;
    assert.ok(l.lines.some((x) => x.includes("wake failed status=401")));
    assert.ok(l.lines.every((x) => !x.includes(WAKE_KEY)));
  });
});

describe("SendPromptHoldQueue + wake hook", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  function queue(send: () => Promise<SendPromptResponse>, wake: SendPromptWakeHook, maxMs = 900_000) {
    return new SendPromptHoldQueue({ filePath: "", maxMs, ui, log: quiet, send, wake });
  }

  it("does nothing when the wake hook is off", async () => {
    const { wake, calls } = hook({ url: "" });
    const q = queue(async () => { throw tunnelDown(); }, wake);
    await q.submit(input("m1"));
    mock.timers.tick(5_000);
    await flush();
    assert.equal(calls.length, 0);
    q.stop();
  });

  it("fires once on a retryable tunnel error with a small body", async () => {
    const { wake, calls } = hook();
    const q = queue(async () => { throw tunnelDown(); }, wake);
    await q.submit(input("m1"));
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, WAKE_URL);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      reason: "tunnel_1033",
      heldCount: 1,
      firstHeldAt: new Date(1_000_000).toISOString(),
    });
    // Retries during the same outage do not fire again.
    for (const step of [5_000, 10_000, 20_000, 30_000]) {
      mock.timers.tick(step);
      await flush();
    }
    assert.equal(calls.length, 1);
    q.stop();
  });

  it("debounces across several held hops and channels", async () => {
    const { wake, calls } = hook();
    const q = queue(async () => { throw tunnelDown(); }, wake);
    await q.submit(input("m1", "c1"));
    await q.submit(input("m2", "c1"));
    mock.timers.tick(2_000);
    await q.submit(input("x1", "c2"));
    await q.submit(input("y1", "c3"));
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(10_000);
      await flush();
    }
    assert.equal(calls.length, 1);
    assert.equal(q.snapshot().filter((h) => h.holding).length, 4);
    q.stop();
  });

  it("re-arms after a successful sendPrompt and fires again on the next outage", async () => {
    const { wake, calls, lines } = hook();
    let up = false;
    const q = queue(async () => {
      if (!up) throw tunnelDown();
      return ok;
    }, wake);
    await q.submit(input("m1"));
    await flush();
    assert.equal(calls.length, 1);
    up = true;
    mock.timers.tick(5_000);
    await flush();
    assert.equal(q.hasLane("c1"), false);
    assert.ok(lines.some((l) => l.includes("re-armed reason=success")));
    up = false;
    mock.timers.tick(60_000);
    await q.submit(input("m2"));
    await flush();
    assert.equal(calls.length, 2);
    const body = JSON.parse(String(calls[1].init.body)) as { firstHeldAt: string };
    assert.equal(body.firstHeldAt, new Date(1_065_000).toISOString());
    q.stop();
  });

  it("re-arms once every held hop has given up", async () => {
    const { wake, calls } = hook();
    const q = queue(async () => { throw tunnelDown(); }, wake, 30_000);
    await q.submit(input("m1"));
    for (let i = 0; i < 40; i++) {
      mock.timers.tick(1_000);
      await flush();
    }
    assert.equal(q.hasLane("c1"), false);
    assert.equal(wake.armed, true);
    await q.submit(input("m2"));
    await flush();
    assert.equal(calls.length, 2);
    q.stop();
  });

  it("does not fire on non-retryable errors", async () => {
    const { wake, calls } = hook();
    for (const err of [
      new SendPromptHttpError("sendPrompt HTTP 401: {}", 401, "{}"),
      new Error("sendPrompt HTTP 403: no"),
      new Error("sendPrompt HTTP 500: boom"),
      new Error("sendPrompt refused: GROK_BOT_GATEWAY_TOKEN blank/unset (fail-closed)"),
    ]) {
      const q = queue(async () => { throw err; }, wake);
      await q.submit(input("m1"));
      await flush();
      q.stop();
    }
    assert.equal(calls.length, 0);
  });

  it("does not fire when holding is off (0s window)", async () => {
    const { wake, calls } = hook();
    const q = queue(async () => { throw tunnelDown(); }, wake, 0);
    await q.submit(input("m1"));
    await flush();
    assert.equal(calls.length, 0);
  });

  it("sends no secrets, message content, user ids or channel names", async () => {
    const { wake, calls } = hook();
    const q = queue(async () => {
      throw new SendPromptHttpError(`sendPrompt HTTP 502: ${GATEWAY_TOKEN} ${SECRET_PROMPT}`, 502, `${SECRET_PROMPT} 1033`);
    }, wake);
    await q.submit(input("1400000000000000001", "1300000000000000001"));
    await flush();
    assert.equal(calls.length, 1);
    const body = String(calls[0].init.body);
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["firstHeldAt", "heldCount", "reason"]);
    for (const bad of [
      WAKE_KEY,
      GATEWAY_TOKEN,
      SECRET_PROMPT,
      "agent-SECRET-ID",
      "123456789012345678",
      "1400000000000000001",
      "1300000000000000001",
      "secret-channel-name",
      "Bearer",
    ]) {
      assert.ok(!body.includes(bad), `body leaked ${bad}`);
    }
    q.stop();
  });

  it("a failing or throwing wake never breaks or delays the retry", async () => {
    const l = recordingLog();
    const rejecting = new SendPromptWakeHook({
      url: WAKE_URL,
      key: WAKE_KEY,
      log: l.log,
      fetchImpl: (async () => { throw new TypeError(`fetch failed ${WAKE_URL} ${WAKE_KEY}`); }) as typeof fetch,
    });
    const hanging = new SendPromptWakeHook({
      url: WAKE_URL,
      key: WAKE_KEY,
      log: l.log,
      fetchImpl: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    });
    for (const wake of [rejecting, hanging]) {
      const callTimes: number[] = [];
      const base = Date.now();
      const q = queue(async () => {
        callTimes.push(Date.now() - base);
        if (callTimes.length < 3) throw tunnelDown();
        return ok;
      }, wake);
      await q.submit(input("m1"));
      await flush();
      mock.timers.tick(5_000);
      await flush();
      mock.timers.tick(10_000);
      await flush();
      assert.deepEqual(callTimes, [0, 5_000, 15_000]);
      assert.equal(q.hasLane("c1"), false);
      q.stop();
    }
    assert.ok(l.lines.some((x) => x.includes("wake failed err=TypeError")));
    assert.ok(l.lines.every((x) => !x.includes(WAKE_KEY) && !x.includes("routine-secret-path")));

    // A hook that throws synchronously is contained too.
    const throwing = { held: () => { throw new Error(WAKE_KEY); }, succeeded: () => { throw new Error("x"); }, idle: () => undefined };
    let n = 0;
    const warns: string[] = [];
    const q = new SendPromptHoldQueue({
      filePath: "",
      maxMs: 900_000,
      ui,
      log: { info: () => undefined, warn: (x) => warns.push(x) },
      send: async () => { if (++n < 2) throw tunnelDown(); return ok; },
      wake: throwing,
    });
    await q.submit(input("m1"));
    await flush();
    mock.timers.tick(5_000);
    await flush();
    assert.equal(n, 2);
    assert.equal(q.hasLane("c1"), false);
    assert.ok(warns.every((x) => !x.includes(WAKE_KEY)));
  });
});
