import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * User directory (0.2.11): Discord user id → who that is.
 *
 * Learned from every inbound message author (and interaction user), merged
 * with an optional read-only seed file, and mirrored to a JSON file on the
 * data volume. Holds names and timestamps only: no secrets, no message text.
 */

export const DEFAULT_USER_DIRECTORY_FILE = "./data/user-directory.json";
export const DEFAULT_USER_DIRECTORY_SEED_FILE = "./config/user-directory.seed.json";

const MAX_NAME = 64;

export interface UserEntry {
  /** Discord username (unique handle, e.g. "kittenclubber"). */
  username?: string;
  /** Discord global display name, when set. */
  globalName?: string;
  /** Best display name last seen: guild nickname, else global name, else username. */
  displayName?: string;
  /** Operator label from the seed (e.g. "Matthew"). Seed always wins. */
  label?: string;
  /** ISO time first seen (or seeded). */
  firstSeen: string;
  /** ISO time last seen in a message or interaction. Absent for seed-only entries. */
  lastSeen?: string;
}

export interface SeedEntry {
  label?: string;
  username?: string;
  displayName?: string;
}

/** Seed file: `{ "version": 1, "users": { "<discordUserId>": { "label": "…" } } }`. */
export interface UserDirectorySeed {
  version?: number;
  users: Record<string, SeedEntry>;
}

export interface LearnInput {
  id: string;
  username?: string | null;
  globalName?: string | null;
  /** Guild nickname / member display name, when known. */
  displayName?: string | null;
}

/** Compact wake identity fields, next to thin-hop `u`. All optional. */
export interface WakeIdentity {
  un?: string;
  dn?: string;
  lb?: string;
}

export interface UserDirectoryOptions {
  /** JSON file path. Empty string = memory only. */
  filePath: string;
  /** Optional seed path. Missing file = no seed. Empty = no seed. */
  seedPath?: string;
  /** Debounce for disk writes in ms (default 2000). 0 = write on every change. */
  writeDelayMs?: number;
  now?: () => Date;
  log?: { info(line: string): void; warn(line: string): void };
}

interface DirectoryFile {
  version: 1;
  users: Record<string, UserEntry>;
}

function clean(v: string | null | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MAX_NAME) : undefined;
}

function isSnowflake(id: string): boolean {
  return /^\d{5,25}$/.test(id);
}

export class UserDirectory {
  private readonly users = new Map<string, UserEntry>();
  private readonly seedLabels = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWriteError = "";
  private readonly now: () => Date;
  private readonly log: { info(line: string): void; warn(line: string): void };

  constructor(private readonly opts: UserDirectoryOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? {
      info: (l) => console.log(l),
      warn: (l) => console.warn(l),
    };
  }

  /** Load the saved directory, then merge the seed. Safe to call once at startup. */
  load(): void {
    const saved = this.readJson<DirectoryFile>(this.opts.filePath, "directory");
    if (saved?.users && typeof saved.users === "object") {
      for (const [id, e] of Object.entries(saved.users)) {
        if (!isSnowflake(id) || !e || typeof e !== "object") continue;
        this.users.set(id, {
          username: clean(e.username),
          globalName: clean(e.globalName),
          displayName: clean(e.displayName),
          label: clean(e.label),
          firstSeen: typeof e.firstSeen === "string" ? e.firstSeen : this.now().toISOString(),
          lastSeen: typeof e.lastSeen === "string" ? e.lastSeen : undefined,
        });
      }
    }
    const seed = this.readJson<UserDirectorySeed>(this.opts.seedPath ?? "", "seed");
    let seeded = 0;
    if (seed?.users && typeof seed.users === "object") {
      for (const [id, s] of Object.entries(seed.users)) {
        if (!isSnowflake(id) || !s || typeof s !== "object") continue;
        this.mergeSeed(id, s);
        seeded++;
      }
    }
    this.log.info(`[users] directory loaded users=${this.users.size} seed=${seeded}`);
    this.persistNow();
  }

  private mergeSeed(id: string, s: SeedEntry): void {
    const label = clean(s.label);
    if (label) this.seedLabels.set(id, label);
    const e = this.users.get(id) ?? { firstSeen: this.now().toISOString() };
    // Seed labels win. Seed names only fill gaps; learned names stay.
    if (label) e.label = label;
    e.username ??= clean(s.username);
    e.displayName ??= clean(s.displayName);
    this.users.set(id, e);
  }

  /** Record or refresh a user seen in a message or interaction. */
  learn(input: LearnInput): UserEntry | undefined {
    const id = String(input.id ?? "");
    if (!isSnowflake(id)) return undefined;
    const nowIso = this.now().toISOString();
    const prev = this.users.get(id);
    const username = clean(input.username);
    const globalName = clean(input.globalName);
    const displayName = clean(input.displayName) ?? globalName ?? username;
    const next: UserEntry = {
      username: username ?? prev?.username,
      globalName: globalName ?? prev?.globalName,
      displayName: displayName ?? prev?.displayName,
      label: this.seedLabels.get(id) ?? prev?.label,
      firstSeen: prev?.firstSeen ?? nowIso,
      lastSeen: nowIso,
    };
    this.users.set(id, next);
    this.schedulePersist();
    return next;
  }

  get(id: string): UserEntry | undefined {
    return this.users.get(id);
  }

  /** Compact identity for the wake JSON. Empty object when nothing is known. */
  wakeIdentity(id: string): WakeIdentity {
    const e = this.users.get(id);
    if (!e) return {};
    const out: WakeIdentity = {};
    if (e.username) out.un = e.username;
    if (e.displayName) out.dn = e.displayName;
    if (e.label) out.lb = e.label;
    return out;
  }

  snapshot(): Record<string, UserEntry> {
    return Object.fromEntries([...this.users.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /** Write any pending change now (tests / shutdown). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.persistNow();
  }

  private schedulePersist(): void {
    if (!this.opts.filePath) return;
    const delay = this.opts.writeDelayMs ?? 2_000;
    if (delay <= 0) {
      this.persistNow();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.persistNow();
    }, delay);
    this.timer.unref?.();
  }

  private persistNow(): void {
    const path = this.opts.filePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const data: DirectoryFile = { version: 1, users: this.snapshot() };
      writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
      renameSync(tmp, path);
      this.lastWriteError = "";
    } catch (err) {
      const text = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      if (text !== this.lastWriteError) {
        this.log.warn(`[users] directory write failed path=${path} err=${text} (memory only)`);
        this.lastWriteError = text;
      }
    }
  }

  private readJson<T>(path: string, what: string): T | undefined {
    if (!path) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        this.log.warn(
          `[users] ${what} file unreadable path=${path} err=${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
        );
      }
      return undefined;
    }
  }
}
