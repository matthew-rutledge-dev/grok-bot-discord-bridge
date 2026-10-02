import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearPendingForTests,
  hopId,
  logTiming,
  markSendPromptAccepted,
  takeIdleGapMs,
} from "./timing.js";

describe("timing helpers", () => {
  it("builds hop id", () => {
    assert.equal(hopId("ai-gen-chat", "123"), "d:ai-gen-chat:123");
  });

  it("tracks idle gap on replyToMessageId", async () => {
    clearPendingForTests();
    markSendPromptAccepted("msg-1");
    await new Promise((r) => setTimeout(r, 20));
    const gap = takeIdleGapMs("msg-1");
    assert.ok(typeof gap === "number" && gap >= 15);
    assert.equal(takeIdleGapMs("msg-1"), undefined);
    assert.equal(takeIdleGapMs(undefined), undefined);
  });

  it("logTiming emits a single [timing] line without secrets", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      logTiming({
        msg: "99",
        hop: "d:slug:99",
        stage: "sendPrompt",
        ms: 42,
        ok: true,
        secret: undefined,
        empty: "",
      });
    } finally {
      console.log = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[timing\] /);
    assert.match(lines[0], /stage=sendPrompt/);
    assert.match(lines[0], /ms=42/);
    assert.match(lines[0], /ok=true/);
    assert.doesNotMatch(lines[0], /secret|Bearer|token/i);
  });
});
