import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatWakePrompt } from "./discord-bot.js";
import { UserDirectory } from "./user-directory.js";

const quiet = { info: () => undefined, warn: () => undefined };
const ALICE = "222222222222222222";
const BOB = "333333333333333333";

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
    d.learn({ id: ALICE, username: "example-user", globalName: "Ali" });
    assert.deepEqual(d.get(ALICE), {
      username: "example-user",
      globalName: "Ali",
      displayName: "Ali",
      label: undefined,
      firstSeen: "2026-10-19T18:00:00.000Z",
      lastSeen: "2026-10-19T18:00:00.000Z",
    });
    clock = new Date("2026-10-19T19:00:00.000Z");
    d.learn({ id: ALICE, username: "example-user", globalName: null, displayName: "Alice (server)" });
    const e = d.get(ALICE)!;
    assert.equal(e.firstSeen, "2026-10-19T18:00:00.000Z");
    assert.equal(e.lastSeen, "2026-10-19T19:00:00.000Z");
    assert.equal(e.globalName, "Ali");
    assert.equal(e.displayName, "Alice (server)");
  });

  it("ignores non-snowflake ids and strips control characters", () => {
    const d = dirAt("");
    assert.equal(d.learn({ id: "abc", username: "x" }), undefined);
    d.learn({ id: BOB, username: "bob\nline", globalName: "  Bob  " });
    assert.equal(d.get(BOB)!.username, "bob line");
    assert.equal(d.get(BOB)!.displayName, "Bob");
  });
});

describe("UserDirectory seed merge", () => {
  it("seed labels win over saved labels; learned names stay", () => {
    const file = join(dir, "users.json");
    const seed = join(dir, "seed.json");
    writeFileSync(file, JSON.stringify({ version: 1, users: { [ALICE]: { username: "example-user", label: "old", firstSeen: "2026-10-01T00:00:00.000Z" } } }));
    writeFileSync(seed, JSON.stringify({ version: 1, users: { [ALICE]: { label: "Alice", username: "seedname" }, [BOB]: { label: "Bob" }, bad: { label: "x" } } }));
    const d = dirAt(file, seed);
    d.load();
    assert.equal(d.get(ALICE)!.label, "Alice");
    assert.equal(d.get(ALICE)!.username, "example-user");
    assert.equal(d.get(ALICE)!.firstSeen, "2026-10-01T00:00:00.000Z");
    assert.equal(d.get(BOB)!.label, "Bob");
    assert.equal(d.get(BOB)!.lastSeen, undefined);
    assert.equal(d.get("bad"), undefined);
    // Learning does not overwrite the seed label.
    d.learn({ id: BOB, username: "bob_b", globalName: "Bob B" });
    assert.equal(d.get(BOB)!.label, "Bob");
    assert.deepEqual(d.wakeIdentity(BOB), { un: "bob_b", dn: "Bob B", lb: "Bob" });
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
    a.learn({ id: ALICE, username: "example-user", globalName: "Ali" });
    const raw = readFileSync(file, "utf8");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(raw, /content|token/i);
    const b = dirAt(file);
    b.load();
    assert.deepEqual(b.get(ALICE), a.get(ALICE));
  });

  it("debounces writes and flush() writes pending changes", () => {
    const file = join(dir, "users.json");
    const d = new UserDirectory({ filePath: file, writeDelayMs: 60_000, now, log: quiet });
    d.load();
    d.learn({ id: ALICE, username: "example-user" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).users, {});
    d.flush();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).users[ALICE].username, "example-user");
  });

  it("memory only when the path is empty", () => {
    const d = dirAt("");
    d.load();
    d.learn({ id: ALICE, username: "m" });
    d.flush();
    assert.equal(d.get(ALICE)!.username, "m");
  });
});

describe("wake prompt identity", () => {
  const base = {
    slug: "dm",
    messageId: "111",
    guildId: null,
    channelId: "222",
    userId: ALICE,
    userTag: "example-user",
    alias: "example-agent",
    cleaned: "hi",
  };

  it("adds un, dn, lb next to u", () => {
    const thin = JSON.parse(formatWakePrompt({ ...base, who: { un: "example-user", dn: "Ali", lb: "Alice" } }).split("\n")[1]);
    assert.deepEqual(thin, { id: "d:dm:111", g: null, u: ALICE, un: "example-user", dn: "Ali", lb: "Alice", map: "example-agent", c: "222" });
  });

  it("omits identity fields that are unknown (backward compatible)", () => {
    const plain = JSON.parse(formatWakePrompt(base).split("\n")[1]);
    assert.deepEqual(Object.keys(plain).sort(), ["c", "g", "id", "map", "u"]);
    const partial = JSON.parse(formatWakePrompt({ ...base, who: { un: "example-user" } }).split("\n")[1]);
    assert.equal(partial.un, "example-user");
    assert.equal("dn" in partial, false);
    assert.equal("lb" in partial, false);
  });

  it("escapes names safely inside the one-line thin JSON", () => {
    const lines = formatWakePrompt({ ...base, who: { dn: 'a"b\\c' } }).split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[1]).dn, 'a"b\\c');
  });
});
