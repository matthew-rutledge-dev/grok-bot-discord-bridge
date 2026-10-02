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
      `sendPrompt non-JSON response status=${res.status} body=${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `sendPrompt HTTP ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`,
    );
  }
  return parsed;
}
