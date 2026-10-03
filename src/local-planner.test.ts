import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  invokeLocalPlanner,
  isLocalPlannerRow,
  joinCallbackUrl,
  withPlannerCallbackQuery,
} from "./local-planner.js";
import type { ChannelMapRow } from "./types.js";

function row(partial: Partial<ChannelMapRow>): ChannelMapRow {
  return {
    enabled: true,
    channelId: "1",
    slug: "x",
    agentId: "95c16f3b-c951-442d-8e18-40c5976d3d7b",
    ...partial,
  };
}

describe("isLocalPlannerRow", () => {
  it("unset fields stay on sendPrompt (fresh install default)", () => {
    assert.equal(isLocalPlannerRow(row({ slug: "ai-gen-images" })), false);
    assert.equal(isLocalPlannerRow(row({ slug: "ai-landscaping" })), false);
    assert.equal(isLocalPlannerRow(row({ slug: "ai-gen-audio", agentId: "9bb81931-e081-4439-8773-f4a5deb81385" })), false);
  });

  it("opts in only for the explicit local trio", () => {
    const opted = {
      primary_llm: "local",
      wake_agent: false,
      local_handler: "rumble-pixel-planner",
    };
    assert.equal(isLocalPlannerRow(row({ slug: "ai-gen-images", channelId: "1509249238419378176", ...opted })), true);
    assert.equal(isLocalPlannerRow(row({ slug: "ai-gen-video", channelId: "1509249242990903386", ...opted })), true);
  });

  it("does not treat partial or lookalike config as local", () => {
    assert.equal(isLocalPlannerRow(row({ primary_llm: "local" })), false);
    assert.equal(isLocalPlannerRow(row({ primary_llm: "local", wake_agent: false })), false);
    assert.equal(
      isLocalPlannerRow(row({ primary_llm: "local", wake_agent: true, local_handler: "rumble-pixel-planner" })),
      false,
    );
    assert.equal(
      isLocalPlannerRow(row({ primary_llm: "local", wake_agent: false, local_handler: "other" })),
      false,
    );
    assert.equal(
      isLocalPlannerRow(row({
        enabled: false,
        primary_llm: "local",
        wake_agent: false,
        local_handler: "rumble-pixel-planner",
      })),
      false,
    );
  });
});

describe("invokeLocalPlanner", () => {
  it("fail-closed without fetch when url or token is blank", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      throw new Error("should not fetch");
    };
    const body = {
      userPrompt: "p",
      imagePath: "",
      channelId: "1",
      slug: "ai-gen-images",
      messageId: "m",
      callbackUrl: "http://127.0.0.1:18083/callback",
      dryRun: true,
    };
    const missing = await invokeLocalPlanner(
      { localPlannerUrl: "", localPlannerToken: "x" },
      body,
      fetchImpl,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.detail, "local_planner_not_configured");
    const blankTok = await invokeLocalPlanner(
      { localPlannerUrl: "http://127.0.0.1:9/plan", localPlannerToken: "  " },
      body,
      fetchImpl,
    );
    assert.equal(blankTok.detail, "local_planner_not_configured");
    assert.equal(called, false);
  });
});

describe("planner callback targeting", () => {
  it("joins callback base and path without a token", () => {
    assert.equal(
      joinCallbackUrl("http://127.0.0.1:18083/", "/callback"),
      "http://127.0.0.1:18083/callback",
    );
    assert.equal(
      joinCallbackUrl("https://callback.example.com", "callback"),
      "https://callback.example.com/callback",
    );
    const url = withPlannerCallbackQuery(
      "http://127.0.0.1:9/plan?slug=local-planner&messageId=bridge-spawn&token=secret",
      "123456789012345678",
      "http://127.0.0.1:18083/callback",
    );
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("messageId"), "123456789012345678");
    assert.equal(parsed.searchParams.get("callbackUrl"), "http://127.0.0.1:18083/callback");
    assert.equal(parsed.searchParams.get("token"), null);
    assert.equal(parsed.searchParams.get("slug"), "local-planner");
  });

  it("posts the inbound message id and callback URL", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenAuth = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string>;
      seenAuth = headers.authorization;
      return new Response(JSON.stringify({ ok: true, exitCode: 0 }), { status: 200 });
    };
    const messageId = "1509249238419378176";
    const callbackUrl = "http://127.0.0.1:18083/callback";
    const result = await invokeLocalPlanner(
      { localPlannerUrl: "http://127.0.0.1:9/plan?messageId=bridge-spawn", localPlannerToken: "planner-token" },
      {
        userPrompt: "edit this",
        imagePath: "https://cdn.example/a.png",
        channelId: "42",
        slug: "ai-gen-images",
        messageId,
        callbackUrl,
        dryRun: false,
      },
      fetchImpl,
    );
    assert.equal(result.ok, true);
    const parsed = new URL(seenUrl);
    assert.equal(parsed.searchParams.get("messageId"), messageId);
    assert.equal(parsed.searchParams.get("callbackUrl"), callbackUrl);
    assert.equal(parsed.search.includes("token="), false);
    assert.equal(parsed.search.includes("bridge-spawn"), false);
    const posted = JSON.parse(seenBody) as { messageId: string; callbackUrl: string };
    assert.equal(posted.messageId, messageId);
    assert.equal(posted.callbackUrl, callbackUrl);
    assert.equal(seenAuth, "Bearer planner-token");
    assert.equal(seenBody.includes("planner-token"), false);
  });
});
