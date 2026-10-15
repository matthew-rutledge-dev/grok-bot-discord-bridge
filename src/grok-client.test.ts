import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientSendError, sendPrompt } from "./grok-client.js";

describe("sendPrompt fail-closed gateway token", () => {
  it("refuses when gatewayToken is undefined", async () => {
    await assert.rejects(
      () =>
        sendPrompt("http://127.0.0.1:9/api/sendPrompt", {
          agentId: "x",
          prompt: "p",
        }),
      /fail-closed|GROK_BOT_GATEWAY_TOKEN/,
    );
  });

  it("refuses when gatewayToken is blank/whitespace", async () => {
    await assert.rejects(
      () =>
        sendPrompt(
          "http://127.0.0.1:9/api/sendPrompt",
          { agentId: "x", prompt: "p" },
          "   ",
        ),
      /fail-closed|GROK_BOT_GATEWAY_TOKEN/,
    );
  });
});

describe("isTransientSendError", () => {
  it("retries a Cloudflare tunnel 530 and not an auth refusal", () => {
    assert.equal(
      isTransientSendError(new Error("sendPrompt HTTP 530: tunnel")),
      true,
    );
    assert.equal(
      isTransientSendError(new Error("sendPrompt HTTP 401: no")),
      false,
    );
    assert.equal(
      isTransientSendError(new Error("sendPrompt refused: GROK_BOT_GATEWAY_TOKEN blank")),
      false,
    );
  });
});

describe("isTransientSendError non-JSON", () => {
  it("retries a non-JSON 502 from the tunnel", () => {
    assert.equal(
      isTransientSendError(new Error("sendPrompt non-JSON response HTTP 502 body=<html>")),
      true,
    );
  });
});
