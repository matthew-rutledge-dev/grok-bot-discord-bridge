import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { isHoldRetryableSendError, SendPromptHttpError } from "./grok-client.js";
import {
  HOLD_GAVE_UP_TEXT,
  HOLD_STATUS_TEXT,
  SendPromptHoldQueue,
  holdRetryDelayMs,
  holdStatusText,
  type HeldHop,
  type HoldInput,
  type HoldUi,
} from "./sendprompt-hold.js";
import type { SendPromptResponse } from "./types.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const quiet = { info: () => undefined, warn: () => undefined };

function input(messageId: string, channelId = "c1"): HoldInput {
  return {
    messageId,
    channelId,
    hop: `d:dm:${messageId}`,
    sendUrl: "http://127.0.0.1:9/api/sendPrompt",
    request: { agentId: "agent", prompt: `p ${messageId}` },
  };
}

const tunnelDown = () =>
  new SendPromptHttpError("sendPrompt non-JSON response HTTP 530 body=error code: 1033", 530, "error code: 1033");

/** Records status text per hop, the way discordHoldUi renders it. */
function recordingUi() {
  const events: string[] = [];
  const status = new Map<string, string[]>();
  let n = 0;
  const push = (hop: HeldHop, text: string) => {
    const list = status.get(hop.messageId) ?? [];
    list.push(text);
    status.set(hop.messageId, list);
  };
  const ui: HoldUi = {
    async holding(hop) {
      events.push(`holding:${hop.messageId}`);
      push(hop, holdStatusText("holding"));
      return hop.statusMessageId ?? `s${++n}`;
    },
    async delivered(hop, _r, info) {
      events.push(`delivered:${hop.messageId}`);
      if (info.held) push(hop, "(status removed)");
    },
    async failed(hop, _e, info) {
      events.push(`failed:${hop.messageId}`);
      if (info.held) push(hop, holdStatusText("gave_up"));
    },
  };
  return { ui, events, status };
}

const ok: SendPromptResponse = { accepted: true };

describe("isHoldRetryableSendError", () => {
  it("holds tunnel and gateway outages", () => {
    assert.equal(isHoldRetryableSendError(new SendPromptHttpError("sendPrompt HTTP 530: x", 530, "")), true);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 502: bad gateway")), true);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 503: x")), true);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 504: x")), true);
    // 1033 deep in an HTML body past the 200-char message slice.
    const html = `${"x".repeat(500)} Error 1033 Argo Tunnel error`;
    assert.equal(isHoldRetryableSendError(new SendPromptHttpError("sendPrompt non-JSON response HTTP 520 body=xxx", 520, html)), true);
    assert.equal(isHoldRetryableSendError(new TypeError("fetch failed")), true);
    assert.equal(isHoldRetryableSendError(new Error("read ECONNRESET")), true);
    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    assert.equal(isHoldRetryableSendError(cause), true);
  });

  it("fails fast on auth, other 4xx, and the blank-token refusal", () => {
    assert.equal(isHoldRetryableSendError(new SendPromptHttpError("sendPrompt HTTP 401: no", 401, "1033")), false);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 403: no")), false);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 400: bad")), false);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 429: slow")), false);
    assert.equal(isHoldRetryableSendError(new Error("sendPrompt HTTP 500: boom")), false);
    assert.equal(
      isHoldRetryableSendError(new Error("sendPrompt refused: GROK_BOT_GATEWAY_TOKEN blank/unset (fail-closed)")),
      false,
    );
  });
});

describe("holdRetryDelayMs", () => {
  it("is 5s, 10s, 20s, then every 30s", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(holdRetryDelayMs), [5000, 10000, 20000, 30000, 30000, 30000]);
    assert.equal(holdRetryDelayMs(0), 0);
  });
});

describe("hold status text", () => {
  it("is plain human text with no codes", () => {
    assert.equal(HOLD_STATUS_TEXT, "Bot is waking up, holding your message…");
    assert.equal(HOLD_GAVE_UP_TEXT, "❌ Couldn't reach the bot, please try again.");
    for (const t of [HOLD_STATUS_TEXT, HOLD_GAVE_UP_TEXT]) assert.doesNotMatch(t, /\d/);
  });
});

describe("SendPromptHoldQueue", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hold-"));
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends once with no hold when the tunnel is up", async () => {
    const { ui, events } = recordingUi();
    let calls = 0;
    const q = new SendPromptHoldQueue({ filePath: join(dir, "h.json"), maxMs: 900_000, ui, log: quiet, send: async () => { calls++; return ok; } });
    await q.submit(input("m1"));
    await flush();
    assert.equal(calls, 1);
    assert.deepEqual(events, ["delivered:m1"]);
    assert.equal(q.hasLane("c1"), false);
  });

  it("retries on the 5s, 10s, 20s, 30s schedule and continues on success", async () => {
    const { ui, events, status } = recordingUi();
    const callTimes: number[] = [];
    const q = new SendPromptHoldQueue({
      filePath: join(dir, "h.json"),
      maxMs: 900_000,
      ui,
      log: quiet,
      send: async () => {
        callTimes.push(Date.now() - 1_000_000);
        if (callTimes.length < 5) throw tunnelDown();
        return ok;
      },
    });
    await q.submit(input("m1"));
    await flush();
    assert.deepEqual(events, ["holding:m1"]);
    for (const step of [4_999, 1, 9_999, 1, 20_000, 30_000]) {
      mock.timers.tick(step);
      await flush();
    }
    assert.deepEqual(callTimes, [0, 5_000, 15_000, 35_000, 65_000]);
    assert.deepEqual(events, ["holding:m1", "delivered:m1"]);
    assert.deepEqual(status.get("m1"), [HOLD_STATUS_TEXT, "(status removed)"]);
    assert.equal(q.hasLane("c1"), false);
  });

  it("gives up with the red X text when the window runs out", async () => {
    const { ui, events, status } = recordingUi();
    let calls = 0;
    const q = new SendPromptHoldQueue({ filePath: join(dir, "h.json"), maxMs: 60_000, ui, log: quiet, send: async () => { calls++; throw tunnelDown(); } });
    await q.submit(input("m1"));
    for (let i = 0; i < 90; i++) {
      mock.timers.tick(1_000);
      await flush();
    }
    // 0, 5, 15, 35, then clamped to the 60s deadline.
    assert.equal(calls, 5);
    assert.deepEqual(events, ["holding:m1", "failed:m1"]);
    assert.deepEqual(status.get("m1"), [HOLD_STATUS_TEXT, HOLD_GAVE_UP_TEXT]);
  });

  it("fails fast without holding on auth errors", async () => {
    const { ui, events } = recordingUi();
    const q = new SendPromptHoldQueue({ filePath: join(dir, "h.json"), maxMs: 900_000, ui, log: quiet, send: async () => { throw new SendPromptHttpError("sendPrompt HTTP 401: {}", 401, "{}"); } });
    await q.submit(input("m1"));
    await flush();
    assert.deepEqual(events, ["failed:m1"]);
  });

  it("keeps per-channel order and lets other channels pass", async () => {
    const { ui, events } = recordingUi();
    let up = false;
    const sent: string[] = [];
    const q = new SendPromptHoldQueue({
      filePath: join(dir, "h.json"),
      maxMs: 900_000,
      ui,
      log: quiet,
      send: async (h) => {
        if (!up && h.channelId === "c1") throw tunnelDown();
        sent.push(h.messageId);
        return ok;
      },
    });
    await q.submit(input("m1", "c1"));
    await q.submit(input("m2", "c1"));
    await q.submit(input("x1", "c2"));
    await flush();
    assert.deepEqual(sent, ["x1"]);
    assert.deepEqual(events, ["holding:m1", "holding:m2", "delivered:x1"]);
    up = true;
    mock.timers.tick(5_000);
    await flush();
    mock.timers.tick(0);
    await flush();
    assert.deepEqual(sent, ["x1", "m1", "m2"]);
    assert.equal(q.hasLane("c1"), false);
  });

  it("persists held hops and replays unexpired ones after a restart", async () => {
    const file = join(dir, "sub", "h.json");
    const first = recordingUi();
    const q1 = new SendPromptHoldQueue({ filePath: file, maxMs: 900_000, ui: first.ui, log: quiet, send: async () => { throw tunnelDown(); } });
    await q1.submit(input("m1"));
    await q1.submit(input("m2"));
    await flush();
    q1.stop();
    const saved = JSON.parse(readFileSync(file, "utf8")) as { hops: HeldHop[] };
    assert.deepEqual(saved.hops.map((h) => h.messageId), ["m1", "m2"]);
    assert.ok(saved.hops.every((h) => h.statusMessageId));
    assert.ok(!JSON.stringify(saved).includes("Bearer"));

    // Add one already-expired hop to the file.
    const stale = { ...saved.hops[0], messageId: "old", channelId: "c9", seq: 0, deadline: Date.now() - 1 };
    writeFileSync(file, JSON.stringify({ version: 1, hops: [stale, ...saved.hops] }));

    mock.timers.tick(60_000);
    const second = recordingUi();
    const sent: string[] = [];
    const q2 = new SendPromptHoldQueue({ filePath: file, maxMs: 900_000, ui: second.ui, log: quiet, send: async (h) => { sent.push(h.messageId); return ok; } });
    await q2.load();
    await flush();
    mock.timers.tick(0);
    await flush();
    mock.timers.tick(0);
    await flush();
    assert.deepEqual(sent, ["m1", "m2"]);
    assert.deepEqual(second.events, ["failed:old", "delivered:m1", "delivered:m2"]);
    assert.deepEqual(second.status.get("old"), [HOLD_GAVE_UP_TEXT]);
    const after = JSON.parse(readFileSync(file, "utf8")) as { hops: HeldHop[] };
    assert.deepEqual(after.hops, []);
  });

  it("with a 0s window the first tunnel error is final", async () => {
    const { ui, events } = recordingUi();
    const q = new SendPromptHoldQueue({ filePath: "", maxMs: 0, ui, log: quiet, send: async () => { throw tunnelDown(); } });
    await q.submit(input("m1"));
    await flush();
    assert.deepEqual(events, ["failed:m1"]);
  });
});
