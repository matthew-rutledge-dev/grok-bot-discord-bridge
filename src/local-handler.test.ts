import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  LOCAL_MEDIA_PLANNER_HANDLER,
  PLANNER_LOG_LINE_RE,
  isGrokBuildRow,
  isLocalPlannerRow,
  normalizeLocalHandler,
} from "./local-planner.js";
import type { ChannelMapRow } from "./types.js";

const RETIRED = "legacy-pixel-planner";
const row = (local_handler: string, extra: Record<string, unknown> = {}) =>
  ({ enabled: true, agentId: "example-agent", primary_llm: "local", wake_agent: false, local_handler, ...extra }) as unknown as ChannelMapRow;

describe("local_handler names", () => {
  it("canonical local-media-planner opts in", () => {
    assert.equal(LOCAL_MEDIA_PLANNER_HANDLER, "local-media-planner");
    assert.equal(isLocalPlannerRow(row("local-media-planner")), true);
  });
  it("retired handler names no longer opt in (0.3.0)", () => {
    assert.equal(normalizeLocalHandler(" local-media-planner "), LOCAL_MEDIA_PLANNER_HANDLER);
    assert.equal(normalizeLocalHandler(RETIRED), RETIRED);
    assert.equal(isLocalPlannerRow(row(RETIRED)), false);
    const gb = { harness: "grok-build", profile: "p" };
    assert.equal(isGrokBuildRow(row("local-media-planner", gb)), false);
  });
  it("unknown handler is still rejected", () => {
    assert.equal(isLocalPlannerRow(row("other-planner")), false);
    assert.equal(isLocalPlannerRow(row("")), false);
  });
});

describe("planner log pattern", () => {
  it("matches the wake marker", () => {
    assert.equal(PLANNER_LOG_LINE_RE.test("step=wake_local_planner ok"), true);
    assert.equal(PLANNER_LOG_LINE_RE.test("unrelated noise"), false);
  });
  it("bin forwarder uses the same pattern", () => {
    const src = readFileSync(new URL("../bin/local-planner-powershell.mjs", import.meta.url), "utf8");
    assert.ok(src.includes("/" + PLANNER_LOG_LINE_RE.source + "/"));
  });
});
