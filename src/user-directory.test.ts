import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatWakePrompt } from "./discord-bot.js";
import { UserDirectory } from "./user-directory.js";

const quiet = { info: () => undefined, warn: () => undefined };
const MATT = "222222222222222222";
const KAY = "333333333333333333";

let dir: string;
let clock: Date;
const now = () => clock;

function dirAt(file: string, seed = ""): UserDirectory {
  return new UserDirectory({ filePath: file, seedPath: seed, writeDelayMs: 0, now, log: quiet });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "users-"));
  clock = new Date("2026-10-19T18:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("UserDirectory learning", () => {
  it("records a new author and refreshes lastSeen and names", () => {
    const d = dirAt("");
    d.load();
    d.learn({ id: MATT, username: "kittenclubber", globalName: "Matt" });
    assert.deepEqual(d.get(MATT), {
      username: "kittenclubber",
      globalName: "Matt",
      displayName: "Matt",
      label: undefined,
      firstSeen: "2026-10-19T18:00:00.000Z",
      lastSeen: "2026-10-19T18:00:00.000Z",
    });
    clock = new Date("2026-10-19T19:00:00.000Z");
    d.learn({ id: MATT, username: "kittenclubber", globalName: null, displayName: "Matt (server)" });
    const e = d.get(MATT)!;
    assert.equal(e.firstSeen, "2026-10-19T18:00:00.000Z");
    assert.equal(e.lastSeen, "2026-10-19T19:00:00.000Z");
    assert.equal(e.globalName, "Matt");
    assert.equal(e.displayName, "Matt (server)");
  });

  it("ignores non-snowflake ids and strips control characters", () => {
    const d = dirAt("");
    assert.equal(d.learn({ id: "abc", username: "x" }), undefined);
    d.learn({ id: KAY, username: "kay\nline", globalName: "  Kay  " });
    assert.equal(d.get(KAY)!.username, "kay line");
    assert.equal(d.get(KAY)!.displayName, "Kay");
  });
});

describe("UserDirectory seed merge", () => {
  it("seed labels win over saved labels; learned names stay", () => {
    const file = join(dir, "users.json");
    const seed = join(dir, "seed.json");
    writeFileSync(file, JSON.stringify({ version: 1, users: { [MATT]: { username: "kittenclubber", label: "old", firstSeen: "2026-10-01T00:00:00.000Z" } } }));
    writeFileSync(seed, JSON.stringify({ version: 1, users: { [MATT]: { label: "Matthew", username: "seedname" }, [KAY]: { label: "Kay" }, bad: { label: "x" } } }));
    const d = dirAt(file, seed);
    d.load();
    assert.equal(d.get(MATT)!.label, "Matthew");
    assert.equal(d.get(MATT)!.username, "kittenclubber");
    assert.equal(d.get(MATT)!.firstSeen, "2026-10-01T00:00:00.000Z");
    assert.equal(d.get(KAY)!.label, "Kay");
    assert.equal(d.get(KAY)!.lastSeen, undefined);
    assert.equal(d.get("bad"), undefined);
    // Learning does not overwrite the seed label.
    d.learn({ id: KAY, username: "kay_d", globalName: "Kay D" });
    assert.equal(d.get(KAY)!.label, "Kay");
    assert.deepEqual(d.wakeIdentity(KAY), { un: "kay_d", dn: "Kay D", lb: "Kay" });
    // The seed file is never written.
    assert.match(readFileSync(seed, "utf8"), /seedname/);
  });

  it("a missing seed file is fine", () => {
    const d = dirAt("", join(dir, "nope.json"));
    d.load();
    assert.deepEqual(d.snapshot(), {});
  });
});

describe("UserDirectory persistence", () => {
  it("writes atomically with owner-only mode and reloads", () => {
    const file = join(dir, "sub", "users.json");
    const a = dirAt(file);
    a.load();
    a.learn({ id: MATT, username: "kittenclubber", globalName: "Matt" });
    const raw = readFileSync(file, "utf8");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(raw, /content|token/i);
    const b = dirAt(file);
    b.load();
    assert.deepEqual(b.get(MATT), a.get(MATT));
  });

  it("debounces writes and flush() writes pending changes", () => {
    const file = join(dir, "users.json");
    const d = new UserDirectory({ filePath: file, writeDelayMs: 60_000, now, log: quiet });
    d.load();
    d.learn({ id: MATT, username: "kittenclubber" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).users, {});
    d.flush();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).users[MATT].username, "kittenclubber");
  });

  it("memory only when the path is empty", () => {
    const d = dirAt("");
    d.load();
    d.learn({ id: MATT, username: "m" });
    d.flush();
    assert.equal(d.get(MATT)!.username, "m");
  });
});

describe("wake prompt identity", () => {
  const base = {
    slug: "dm",
    messageId: "111",
    guildId: null,
    channelId: "222",
    userId: MATT,
    userTag: "kittenclubber",
    alias: "Rimuru_orch",
    cleaned: "hi",
  };

  it("adds un, dn, lb next to u", () => {
    const thin = JSON.parse(formatWakePrompt({ ...base, who: { un: "kittenclubber", dn: "Matt", lb: "Matthew" } }).split("\n")[1]);
    assert.deepEqual(thin, { id: "d:dm:111", g: null, u: MATT, un: "kittenclubber", dn: "Matt", lb: "Matthew", map: "Rimuru_orch", c: "222" });
  });

  it("omits identity fields that are unknown (backward compatible)", () => {
    const plain = JSON.parse(formatWakePrompt(base).split("\n")[1]);
    assert.deepEqual(Object.keys(plain).sort(), ["c", "g", "id", "map", "u"]);
    const partial = JSON.parse(formatWakePrompt({ ...base, who: { un: "kittenclubber" } }).split("\n")[1]);
    assert.equal(partial.un, "kittenclubber");
    assert.equal("dn" in partial, false);
    assert.equal("lb" in partial, false);
  });

  it("escapes names safely inside the one-line thin JSON", () => {
    const lines = formatWakePrompt({ ...base, who: { dn: 'a"b\\c' } }).split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[1]).dn, 'a"b\\c');
  });
});
