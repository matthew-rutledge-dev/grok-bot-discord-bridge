import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveVoiceEngine } from "./grok-voice.js";

describe("resolveVoiceEngine", () => {
  it("defaults to local Piper", () => {
    assert.equal(resolveVoiceEngine(undefined), "local");
    assert.equal(resolveVoiceEngine(""), "local");
    assert.equal(resolveVoiceEngine("piper"), "local");
  });

  it("selects Grok Voice only when asked", () => {
    assert.equal(resolveVoiceEngine("grok"), "grok");
    assert.equal(resolveVoiceEngine("grok-voice-latest"), "grok");
    assert.equal(resolveVoiceEngine("grok-voice-3.0"), "grok");
  });

  it("rejects an unknown engine", () => {
    assert.throws(() => resolveVoiceEngine("cloud"), /voice_engine/);
  });
});
