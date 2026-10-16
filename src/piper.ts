import net from "node:net";

const VOICE_RATE = 48000;

export type PcmClip = {
  pcm: Buffer;
  rate: number;
  channels: number;
  width: number;
};

/** Ask the Home Assistant Wyoming Piper service for one spoken line. */
export function synthesizePiper(
  text: string,
  host = process.env.PIPER_HOST || "host.docker.internal",
  port = Number(process.env.PIPER_PORT || "10200"),
): Promise<PcmClip> {
  const spoken = text.trim().slice(0, 240);
  if (!spoken) return Promise.reject(new Error("piper_text_required"));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    let buf = Buffer.alloc(0);
    let rate = 22050;
    let channels = 1;
    let width = 2;
    let settled = false;
    const finish = (err?: Error, clip?: PcmClip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(clip as PcmClip);
    };
    const timer = setTimeout(() => finish(new Error("piper_timeout")), 15_000);
    socket.on("error", (err) => finish(err));
    socket.on("connect", () => {
      const data = Buffer.from(JSON.stringify({ text: spoken }), "utf8");
      const header = JSON.stringify({
        type: "synthesize",
        data_length: data.length,
        version: "1.6.0",
      });
      socket.write(header + "\n");
      socket.write(data);
    });
    const pump = () => {
      while (!settled) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        let ev: { type?: string; data_length?: number; payload_length?: number; data?: Record<string, number> };
        try {
          ev = JSON.parse(buf.subarray(0, nl).toString("utf8"));
        } catch {
          finish(new Error("piper_bad_event"));
          return;
        }
        const dataLen = Number(ev.data_length || 0);
        const payloadLen = Number(ev.payload_length || 0);
        const need = nl + 1 + dataLen + payloadLen;
        if (buf.length < need) return;
        const dataBytes = buf.subarray(nl + 1, nl + 1 + dataLen);
        const payload = buf.subarray(nl + 1 + dataLen, need);
        buf = buf.subarray(need);
        const data = dataBytes.length
          ? (JSON.parse(dataBytes.toString("utf8")) as Record<string, number>)
          : ev.data;
        if (ev.type === "audio-start" && data) {
          rate = Number(data.rate || rate);
          channels = Number(data.channels || channels);
          width = Number(data.width || width);
        }
        if (ev.type === "audio-chunk" && payload.length) chunks.push(Buffer.from(payload));
        if (ev.type === "error") {
          finish(new Error("piper_error"));
          return;
        }
        if (ev.type === "audio-stop") {
          finish(undefined, { pcm: Buffer.concat(chunks), rate, channels, width });
          return;
        }
      }
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on("close", () => {
      if (!settled) finish(new Error("piper_closed"));
    });
  });
}

/** Discord raw voice is 48 kHz stereo s16le. */
export function toVoicePcm(clip: PcmClip): Buffer {
  if (clip.width !== 2 || clip.channels < 1 || clip.rate < 1) {
    throw new Error("piper_format");
  }
  const frames = Math.floor(clip.pcm.length / (clip.width * clip.channels));
  if (frames < 1) throw new Error("piper_empty");
  const outFrames = Math.max(1, Math.round((frames * VOICE_RATE) / clip.rate));
  const out = Buffer.alloc(outFrames * 2 * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = Math.min(frames - 1, Math.floor((i * clip.rate) / VOICE_RATE));
    let sum = 0;
    for (let c = 0; c < clip.channels; c++) {
      sum += clip.pcm.readInt16LE((src * clip.channels + c) * 2);
    }
    const n = Math.max(-32767, Math.min(32767, Math.round(sum / clip.channels)));
    out.writeInt16LE(n, i * 4);
    out.writeInt16LE(n, i * 4 + 2);
  }
  return out;
}
