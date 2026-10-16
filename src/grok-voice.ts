import WebSocket from "ws";
import type { PcmClip } from "./piper.js";

/** Local Piper unless the caller explicitly asks for Grok Voice. */
export function resolveVoiceEngine(raw: unknown): "local" | "grok" {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value || value === "local" || value === "piper") return "local";
  if (value === "grok" || value === "grok-voice-latest" || value === "grok-voice-3.0") {
    return "grok";
  }
  throw new Error("voice_engine");
}

/**
 * Speak one line with the Voice Agent API.
 * `grok-voice-latest` is the Voice 3.0 alias. Output is 48 kHz mono s16le.
 */
export function synthesizeGrokVoice(
  text: string,
  apiKey = process.env.XAI_API_KEY || "",
): Promise<PcmClip> {
  const spoken = text.trim().slice(0, 240);
  if (!spoken) return Promise.reject(new Error("grok_text_required"));
  if (!apiKey.trim()) return Promise.reject(new Error("grok_voice_not_configured"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err?: Error, clip?: PcmClip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(clip as PcmClip);
    };
    const timer = setTimeout(() => finish(new Error("grok_voice_timeout")), 20_000);
    ws.on("error", (err) => finish(err));
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "ara",
          instructions: "Read the user message aloud exactly. Do not add words.",
          turn_detection: null,
          audio: {
            output: { format: { type: "audio/pcm", rate: 48000 } },
          },
        },
      }));
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: spoken }],
        },
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    });
    ws.on("message", (data) => {
      let event: { type?: string; delta?: string };
      try {
        event = JSON.parse(data.toString()) as { type?: string; delta?: string };
      } catch {
        return;
      }
      if (event.type === "response.output_audio.delta" && event.delta) {
        chunks.push(Buffer.from(event.delta, "base64"));
      }
      if (event.type === "error") finish(new Error("grok_voice_error"));
      if (event.type === "response.done" || event.type === "response.output_audio.done") {
        if (!chunks.length) {
          finish(new Error("grok_voice_empty"));
          return;
        }
        finish(undefined, {
          pcm: Buffer.concat(chunks),
          rate: 48000,
          channels: 1,
          width: 2,
        });
      }
    });
  });
}
