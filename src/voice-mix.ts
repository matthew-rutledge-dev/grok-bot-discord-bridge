/** 48 kHz stereo s16le mixer. One 20 ms frame is 3840 bytes. */

export const FRAME_SAMPLES = 960;
export const FRAME_BYTES = FRAME_SAMPLES * 4;
const MAX_SECONDS = 30;
const MAX_BYTES = 48000 * 2 * 2 * MAX_SECONDS;

export type MixLayer = {
  id: string;
  pcm: Buffer;
  pos: number;
  loop: boolean;
  gain: number;
};

export class PcmMixer {
  private layers = new Map<string, MixLayer>();

  add(layer: { id: string; pcm: Buffer; loop: boolean; gain: number }): void {
    if (!layer.id) throw new Error("layer_id_required");
    if (layer.pcm.length < 4 || layer.pcm.length % 4 !== 0) throw new Error("pcm_format");
    if (layer.pcm.length > MAX_BYTES) throw new Error("audio_too_long");
    const gain = clampGain(layer.gain);
    this.layers.set(layer.id, {
      id: layer.id,
      pcm: layer.pcm,
      pos: 0,
      loop: layer.loop,
      gain,
    });
  }

  remove(id: string): boolean {
    return this.layers.delete(id);
  }

  list(): { id: string; loop: boolean; framesLeft: number }[] {
    return [...this.layers.values()].map((layer) => ({
      id: layer.id,
      loop: layer.loop,
      framesLeft: layer.loop
        ? -1
        : Math.ceil((layer.pcm.length / 4 - layer.pos) / FRAME_SAMPLES),
    }));
  }

  /** Next 20 ms of mixed audio. Ended one-shot layers are dropped. */
  nextFrame(): Buffer {
    const out = Buffer.alloc(FRAME_BYTES);
    const ended: string[] = [];
    for (const layer of this.layers.values()) {
      const alive = mixLayer(out, layer);
      if (!alive || (!layer.loop && layer.pos >= layer.pcm.length / 4)) ended.push(layer.id);
    }
    for (const id of ended) this.layers.delete(id);
    return out;
  }
}

function mixLayer(out: Buffer, layer: MixLayer): boolean {
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    if (layer.pos >= layer.pcm.length / 4) {
      if (!layer.loop) return false;
      layer.pos = 0;
    }
    const base = layer.pos * 4;
    for (let ch = 0; ch < 2; ch++) {
      const at = i * 4 + ch * 2;
      const mixed = out.readInt16LE(at) + Math.round(layer.pcm.readInt16LE(base + ch * 2) * layer.gain);
      out.writeInt16LE(Math.max(-32767, Math.min(32767, mixed)), at);
    }
    layer.pos += 1;
  }
  return true;
}

export function clampGain(gain: number): number {
  if (!Number.isFinite(gain)) return 1;
  return Math.max(0, Math.min(1, gain));
}

/** Decode a 16-bit PCM wav into 48 kHz stereo s16le. */
export function wavToVoicePcm(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("wav_format");
  }
  let fmt: { rate: number; channels: number; width: number } | null = null;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("wav_format");
    if (id === "fmt ") {
      const audioFormat = wav.readUInt16LE(start);
      const channels = wav.readUInt16LE(start + 2);
      const rate = wav.readUInt32LE(start + 4);
      const bits = wav.readUInt16LE(start + 14);
      if (audioFormat !== 1 || bits !== 16 || channels < 1 || channels > 2 || rate < 1) {
        throw new Error("wav_format");
      }
      fmt = { rate, channels, width: 2 };
    } else if (id === "data") {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || data.length < fmt.channels * 2) throw new Error("wav_format");
  const frames = Math.floor(data.length / (fmt.channels * 2));
  const outFrames = Math.max(1, Math.round((frames * 48000) / fmt.rate));
  if (outFrames > 48000 * MAX_SECONDS) throw new Error("audio_too_long");
  const out = Buffer.alloc(outFrames * 4);
  for (let i = 0; i < outFrames; i++) {
    const src = Math.min(frames - 1, Math.floor((i * fmt.rate) / 48000));
    for (let ch = 0; ch < 2; ch++) {
      const srcCh = Math.min(ch, fmt.channels - 1);
      const sample = data.readInt16LE((src * fmt.channels + srcCh) * 2);
      out.writeInt16LE(sample, i * 4 + ch * 2);
    }
  }
  return out;
}
