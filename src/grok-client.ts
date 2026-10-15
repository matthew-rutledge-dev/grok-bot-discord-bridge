import type { SendPromptRequest, SendPromptResponse } from "./types.js";

/**
 * Outbound wake to Grok Bot sendPrompt.
 * Fail-closed: GROK_BOT_GATEWAY_TOKEN must be non-empty or the request is refused
 * (no unauthenticated POST). When set, sent as Authorization: Bearer.
 */
export async function sendPrompt(
  url: string,
  body: SendPromptRequest,
  gatewayToken?: string,
): Promise<SendPromptResponse> {
  const token = (gatewayToken ?? "").trim();
  if (!token) {
    throw new Error(
      "sendPrompt refused: GROK_BOT_GATEWAY_TOKEN blank/unset (fail-closed)",
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: SendPromptResponse;
  try {
    parsed = JSON.parse(text) as SendPromptResponse;
  } catch {
    throw new Error(
      `sendPrompt non-JSON response HTTP ${res.status} body=${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `sendPrompt HTTP ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`,
    );
  }
  return parsed;
}

/** Tunnel and gateway blips. Auth and bad requests are not retried. */
export function isTransientSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("GROK_BOT_GATEWAY_TOKEN")) return false;
  const status = /HTTP (\d{3})/.exec(msg);
  if (status) {
    const code = Number(status[1]);
    return (
      code === 408 ||
      code === 429 ||
      code === 502 ||
      code === 503 ||
      code === 504 ||
      (code >= 520 && code <= 530)
    );
  }
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(msg);
}

/**
 * One immediate try plus two delayed tries for a tunnel blip.
 * The 530/1033 case is Cloudflare being unable to reach the tunnel, not a bridge reject.
 */
export async function sendPromptWithRetry(
  url: string,
  body: SendPromptRequest,
  gatewayToken?: string,
  opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<SendPromptResponse> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const waits = [0, 2000, 5000];
  let last: unknown;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i] > 0) await sleep(waits[i]);
    try {
      return await sendPrompt(url, body, gatewayToken);
    } catch (err) {
      last = err;
      const text = err instanceof Error ? err.message : String(err);
      if (!isTransientSendError(err) || i === waits.length - 1) {
        if (isTransientSendError(err)) {
          console.error(
            `[sendPrompt] tunnel or gateway still unreachable after ${waits.length} tries: ${text.slice(0, 300)}`,
          );
        }
        throw err;
      }
      console.warn(
        `[sendPrompt] transient try ${i + 1}/${waits.length} ${text.slice(0, 180)}`,
      );
    }
  }
  throw last;
}
