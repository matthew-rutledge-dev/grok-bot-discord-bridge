import type { SendPromptRequest, SendPromptResponse } from "./types.js";

export async function sendPrompt(
  url: string,
  body: SendPromptRequest,
  gatewayToken?: string,
): Promise<SendPromptResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (gatewayToken) {
    headers.authorization = `Bearer ${gatewayToken}`;
  }

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
