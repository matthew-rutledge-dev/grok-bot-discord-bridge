const RATE = 48000;

/** Quiet two-note bed plus noise under an existing 48 kHz stereo voice clip. */
export function mixLocalBed(voice: Buffer): Buffer {
  const frames = Math.floor(voice.length / 4);
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / RATE;
    const tone =
      Math.sin(2 * Math.PI * 110 * t) * 0.07 +
      Math.sin(2 * Math.PI * 164.81 * t) * 0.04;
    const noise = (Math.random() * 2 - 1) * 0.025;
    const bed = (tone + noise) * 32767;
    for (let ch = 0; ch < 2; ch++) {
      const sample = voice.readInt16LE(i * 4 + ch * 2);
      const mixed = Math.max(-32767, Math.min(32767, Math.round(sample + bed)));
      out.writeInt16LE(mixed, i * 4 + ch * 2);
    }
  }
  return out;
}
