import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mixLocalBed } from "./mix.js";

describe("mixLocalBed", () => {
  it("keeps the voice length and stays in range", () => {
    const voice = Buffer.alloc(48000 * 2 * 2);
    voice.writeInt16LE(10000, 0);
    const mixed = mixLocalBed(voice);
    assert.equal(mixed.length, voice.length);
    assert.ok(Math.abs(mixed.readInt16LE(0)) <= 32767);
  });
});
