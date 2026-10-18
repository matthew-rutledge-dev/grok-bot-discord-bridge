import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRAME_BYTES, FRAME_SAMPLES, PcmMixer, wavToVoicePcm } from "./voice-mix.js";

function tone(frames: number, amp: number): Buffer {
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const n = Math.round(Math.sin(i / 10) * amp);
    pcm.writeInt16LE(n, i * 4);
    pcm.writeInt16LE(n, i * 4 + 2);
  }
  return pcm;
}

describe("PcmMixer", () => {
  it("sends silence when nothing is queued", () => {
    const frame = new PcmMixer().nextFrame();
    assert.equal(frame.length, FRAME_BYTES);
    assert.ok(frame.every((b) => b === 0));
  });

  it("adds a layer and removes it", () => {
    const mixer = new PcmMixer();
    mixer.add({ id: "music", pcm: tone(FRAME_SAMPLES, 1000), loop: true, gain: 1 });
    const frame = mixer.nextFrame();
    assert.ok(frame.some((b) => b !== 0));
    assert.equal(mixer.remove("music"), true);
    assert.ok(mixer.nextFrame().every((b) => b === 0));
  });

  it("drops a one-shot layer after it ends", () => {
    const mixer = new PcmMixer();
    mixer.add({ id: "speech", pcm: tone(FRAME_SAMPLES, 500), loop: false, gain: 1 });
    mixer.nextFrame();
    assert.deepEqual(mixer.list(), []);
  });

  it("loops a short layer into the next frame", () => {
    const mixer = new PcmMixer();
    mixer.add({ id: "loop", pcm: tone(10, 800), loop: true, gain: 1 });
    mixer.nextFrame();
    assert.equal(mixer.list()[0]?.loop, true);
    assert.ok(mixer.nextFrame().some((b) => b !== 0));
  });
});

describe("wavToVoicePcm", () => {
  it("expands 16-bit mono wav to 48 kHz stereo", () => {
    const samples = 4;
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) data.writeInt16LE(1000, i * 2);
    const wav = Buffer.alloc(44 + data.length);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + data.length, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(96000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(data.length, 40);
    data.copy(wav, 44);
    const pcm = wavToVoicePcm(wav);
    assert.equal(pcm.length, samples * 4);
    assert.equal(pcm.readInt16LE(0), 1000);
    assert.equal(pcm.readInt16LE(2), 1000);
  });
});
