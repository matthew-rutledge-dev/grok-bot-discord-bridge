import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { User } from "discord.js";
import type { AppConfig } from "./config.js";
import { authorizeDm, dmRecipientAllowed, isHostAdmin } from "./security.js";
import type { SecurityFile } from "./types.js";

const owner = "222222222222222222";
const linda = "333333333333333333";
const kay = "444444444444444444";

function cfg(security: SecurityFile): AppConfig {
  return {
    dmPolicy: "allowlist",
    allowFrom: [],
    sendPromptUrl: "http://127.0.0.1:9/api/sendPrompt",
    security,
  } as AppConfig;
}

function user(id: string): User {
  return { id, bot: false } as User;
}

const security: SecurityFile = {
  version: 1,
  ignoreBots: true,
  guilds: {},
  dm: {
    policy: "allowlist",
    allowFrom: [owner, linda],
    defaultAgentId: "rimuru-example",
    agentsByUser: {
      [linda]: { agentId: "hinata-example", alias: "Hinata_desktop" },
    },
  },
  hostAdmins: {
    "example-host-a": [owner],
    "example-host-b": [owner],
    "example-host-c": [owner, linda],
  },
};

describe("authorizeDm", () => {
  const app = cfg(security);

  it("uses the default agent when the person has no assignment", () => {
    const result = authorizeDm(app, user(owner));
    assert.equal(result.ok, true);
    assert.equal(result.agentId, "rimuru-example");
    assert.equal(result.alias, undefined);
  });

  it("uses the per-person agent when one is set", () => {
    const result = authorizeDm(app, user(linda));
    assert.equal(result.ok, true);
    assert.equal(result.agentId, "hinata-example");
    assert.equal(result.alias, "Hinata_desktop");
  });

  it("denies a person who is not on the DM allow list", () => {
    const result = authorizeDm(app, user(kay));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "user_not_allowlisted");
  });
});

describe("dmRecipientAllowed", () => {
  const app = cfg(security);

  it("allows listed people and rejects everyone else", () => {
    assert.equal(dmRecipientAllowed(app, owner), true);
    assert.equal(dmRecipientAllowed(app, linda), true);
    assert.equal(dmRecipientAllowed(app, kay), false);
  });
});

describe("isHostAdmin", () => {
  const app = cfg(security);

  it("puts the owner on every host and the second person on one host", () => {
    assert.equal(isHostAdmin(app, "example-host-a", owner), true);
    assert.equal(isHostAdmin(app, "example-host-b", owner), true);
    assert.equal(isHostAdmin(app, "example-host-c", owner), true);
    assert.equal(isHostAdmin(app, "example-host-c", linda), true);
    assert.equal(isHostAdmin(app, "example-host-a", linda), false);
    assert.equal(isHostAdmin(app, "example-host-a", kay), false);
    assert.equal(isHostAdmin(app, "example-host-c", kay), false);
  });
});
