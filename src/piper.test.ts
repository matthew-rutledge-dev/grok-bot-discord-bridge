import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toVoicePcm } from "./piper.js";

describe("toVoicePcm", () => {
  it("expands one 22.05 kHz mono frame toward 48 kHz stereo", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(1000, 0);
    const out = toVoicePcm({ pcm, rate: 22050, channels: 1, width: 2 });
    assert.equal(out.length % 4, 0);
    assert.ok(out.length >= 4);
    assert.equal(out.readInt16LE(0), 1000);
    assert.equal(out.readInt16LE(2), 1000);
  });
});
