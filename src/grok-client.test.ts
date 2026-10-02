import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendPrompt } from "./grok-client.js";

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
