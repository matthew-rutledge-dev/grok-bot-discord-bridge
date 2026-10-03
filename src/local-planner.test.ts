import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PLANNER_START_FAILED_TEXT,
  PLANNER_WORKING_TEXT,
  forgetPlannerStatus,
  invokeLocalPlanner,
  isLocalPlannerRow,
  joinCallbackUrl,
  lookupPlannerStatus,
  plannerUserSignal,
  rememberPlannerStatus,
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
    assert.equal(parsed.searchParams.get("statusMessageId"), null);
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

describe("planner progress is not a timeout failure", () => {
  it("names the working message and the start-failure edit", () => {
    assert.equal(PLANNER_WORKING_TEXT, "Working on it.");
    assert.equal(PLANNER_START_FAILED_TEXT, "Couldn't start that.");
    assert.equal(PLANNER_WORKING_TEXT.includes("⏳"), false);
  });

  it("treats a dropped fetch as transport, not a final failure", async () => {
    let sawSignal = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sawSignal = Boolean(init?.signal);
      throw new TypeError("fetch failed");
    };
    const result = await invokeLocalPlanner(
      { localPlannerUrl: "http://127.0.0.1:9/plan", localPlannerToken: "planner-token" },
      {
        userPrompt: "hat",
        imagePath: "",
        channelId: "42",
        slug: "ai-gen-images",
        messageId: "1555776603705835603",
        callbackUrl: "http://127.0.0.1:18083/callback",
        statusMessageId: "9001",
        dryRun: false,
      },
      fetchImpl,
    );
    assert.equal(sawSignal, false);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.detail, "local_planner_transport");
    assert.equal(plannerUserSignal(result), "transport");
  });

  it("still aborts only when asked, and that abort is transport", async () => {
    let sawSignal = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sawSignal = Boolean(init?.signal);
      throw new DOMException("The operation was aborted", "TimeoutError");
    };
    const result = await invokeLocalPlanner(
      { localPlannerUrl: "http://127.0.0.1:9/plan", localPlannerToken: "t" },
      {
        userPrompt: "hat",
        imagePath: "",
        channelId: "42",
        slug: "ai-gen-images",
        messageId: "1555776603705835603",
        callbackUrl: "http://127.0.0.1:18083/callback",
        dryRun: false,
      },
      fetchImpl,
      50,
      { abort: true },
    );
    assert.equal(sawSignal, true);
    assert.equal(plannerUserSignal(result), "transport");
  });

  it("posts statusMessageId on the query and body, never a token", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true, exitCode: 0 }), { status: 200 });
    };
    const result = await invokeLocalPlanner(
      { localPlannerUrl: "http://127.0.0.1:9/plan?token=secret&messageId=bridge-spawn", localPlannerToken: "planner-token" },
      {
        userPrompt: "hat",
        imagePath: "",
        channelId: "42",
        slug: "ai-gen-images",
        messageId: "1555776603705835603",
        callbackUrl: "http://127.0.0.1:18083/callback",
        statusMessageId: "9001",
        dryRun: false,
      },
      fetchImpl,
    );
    assert.equal(result.ok, true);
    assert.equal(plannerUserSignal(result), "accepted");
    const parsed = new URL(seenUrl);
    assert.equal(parsed.searchParams.get("messageId"), "1555776603705835603");
    assert.equal(parsed.searchParams.get("statusMessageId"), "9001");
    assert.equal(parsed.searchParams.get("token"), null);
    const posted = JSON.parse(seenBody) as { messageId: string; statusMessageId: string; callbackUrl: string };
    assert.equal(posted.messageId, "1555776603705835603");
    assert.equal(posted.statusMessageId, "9001");
    assert.equal(posted.callbackUrl, "http://127.0.0.1:18083/callback");
    assert.equal(seenBody.includes("planner-token"), false);
    assert.equal(seenBody.includes("secret"), false);
  });

  it("classifies start failures separately from a finished non-ok", () => {
    assert.equal(plannerUserSignal({ ok: false, status: 0, detail: "local_planner_not_configured" }), "start_failed");
    assert.equal(plannerUserSignal({ ok: false, status: 0, detail: "local_planner_bad_url" }), "start_failed");
    assert.equal(plannerUserSignal({ ok: false, status: 401, detail: "unauthorized" }), "start_failed");
    assert.equal(plannerUserSignal({ ok: false, status: 500, detail: "exit", exitCode: 1 }), "inconclusive");
  });

  it("remembers a working message by the inbound Discord message id", () => {
    forgetPlannerStatus("1555776603705835603", "9001");
    rememberPlannerStatus("1555776603705835603", { channelId: "42", statusMessageId: "9001" });
    assert.equal(lookupPlannerStatus("1555776603705835603")?.statusMessageId, "9001");
    forgetPlannerStatus(undefined, "9001");
    assert.equal(lookupPlannerStatus("1555776603705835603"), undefined);
  });
});
