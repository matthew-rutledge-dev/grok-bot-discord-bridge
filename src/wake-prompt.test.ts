import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatWakePrompt } from "./discord-bot.js";

const base = {
  slug: "dm",
  messageId: "111",
  guildId: null,
  channelId: "222",
  userId: "333",
  userTag: "kay",
  alias: "Milim_kay",
  cleaned: "hi",
};

describe("formatWakePrompt", () => {
  it("adds channel snowflake c for DMs", () => {
    const [id, thin, text] = formatWakePrompt(base).split("\n");
    assert.equal(id, "d:dm:111");
    assert.deepEqual(JSON.parse(thin), { id: "d:dm:111", g: null, u: "333", map: "Milim_kay", c: "222" });
    assert.equal(text, "hi");
  });
  it("keeps the old fields and a for guild messages", () => {
    const thin = JSON.parse(
      formatWakePrompt({ ...base, guildId: "9", attachments: [{ url: "u" }] }).split("\n")[1],
    );
    assert.equal(thin.g, "9");
    assert.equal(thin.c, "222");
    assert.deepEqual(thin.a, [{ url: "u" }]);
  });
});
