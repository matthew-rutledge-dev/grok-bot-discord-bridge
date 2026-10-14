import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTonePcm } from "./voice-play.js";

describe("buildTonePcm", () => {
  it("builds two seconds of 48 kHz stereo s16le", () => {
    const pcm = buildTonePcm(2);
    assert.equal(pcm.length, 48000 * 2 * 2 * 2);
  });
});
