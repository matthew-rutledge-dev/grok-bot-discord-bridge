import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { User } from "discord.js";
import type { AppConfig } from "./config.js";
import { authorizeDm, dmRecipientAllowed, isHostAdmin } from "./security.js";
import type { SecurityFile } from "./types.js";

const owner = "222222222222222222";
const carol = "333333333333333333";
const bob = "444444444444444444";

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
    allowFrom: [owner, carol],
    defaultAgentId: "example-agent",
    agentsByUser: {
      [carol]: { agentId: "example-agent-2", alias: "example-agent-2" },
    },
  },
  hostAdmins: {
    "example-host-a": [owner],
    "example-host-b": [owner],
    "example-host-c": [owner, carol],
  },
};

describe("authorizeDm", () => {
  const app = cfg(security);

  it("uses the default agent when the person has no assignment", () => {
    const result = authorizeDm(app, user(owner));
    assert.equal(result.ok, true);
    assert.equal(result.agentId, "example-agent");
    assert.equal(result.alias, undefined);
  });

  it("uses the per-person agent when one is set", () => {
    const result = authorizeDm(app, user(carol));
    assert.equal(result.ok, true);
    assert.equal(result.agentId, "example-agent-2");
    assert.equal(result.alias, "example-agent-2");
  });

  it("denies a person who is not on the DM allow list", () => {
    const result = authorizeDm(app, user(bob));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "user_not_allowlisted");
  });
});

describe("dmRecipientAllowed", () => {
  const app = cfg(security);

  it("allows listed people and rejects everyone else", () => {
    assert.equal(dmRecipientAllowed(app, owner), true);
    assert.equal(dmRecipientAllowed(app, carol), true);
    assert.equal(dmRecipientAllowed(app, bob), false);
  });
});

describe("isHostAdmin", () => {
  const app = cfg(security);

  it("puts the owner on every host and the second person on one host", () => {
    assert.equal(isHostAdmin(app, "example-host-a", owner), true);
    assert.equal(isHostAdmin(app, "example-host-b", owner), true);
    assert.equal(isHostAdmin(app, "example-host-c", owner), true);
    assert.equal(isHostAdmin(app, "example-host-c", carol), true);
    assert.equal(isHostAdmin(app, "example-host-a", carol), false);
    assert.equal(isHostAdmin(app, "example-host-a", bob), false);
    assert.equal(isHostAdmin(app, "example-host-c", bob), false);
  });
});
