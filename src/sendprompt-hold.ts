import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isHoldRetryableSendError } from "./grok-client.js";
import { NO_WAKE, type HoldWakeHook } from "./sendprompt-wake.js";
import type { SendPromptRequest, SendPromptResponse } from "./types.js";

/**
 * Hold-and-retry for sendPrompt tunnel outages (0.2.10).
 *
 * When the Grok Bot computer sleeps, the public tunnel edge answers 530 /
 * Cloudflare 1033 until it wakes. Instead of a red X after a few seconds, the
 * hop is held: kept in memory, mirrored to a JSON file, and retried with
 * backoff (5s, 10s, 20s, then every 30s) until the hold window runs out.
 * Hops from one Discord channel stay in order: a later hop waits behind an
 * earlier held one.
 */

/** Plain human status while a hop is held. No codes. */
export const HOLD_STATUS_TEXT = "Bot is waking up, holding your message…";
/** Final status when the hold window runs out (or the bot refuses mid-hold). */
export const HOLD_GAVE_UP_TEXT = "❌ Couldn't reach the bot, please try again.";

export const DEFAULT_HOLD_MAX_SEC = 900;
/** Relative to the working directory. In the image that is /app/data (a named volume). */
export const DEFAULT_HOLD_FILE = "./data/sendprompt-hold.json";

const BACKOFF_MS = [5_000, 10_000, 20_000];
const STEADY_MS = 30_000;

/** Wait before the next try after `failures` failed tries (1 → 5s, 2 → 10s, 3 → 20s, 4+ → 30s). */
export function holdRetryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return BACKOFF_MS[failures - 1] ?? STEADY_MS;
}

export type HoldPhase = "holding" | "gave_up";

export function holdStatusText(phase: HoldPhase): string {
  return phase === "holding" ? HOLD_STATUS_TEXT : HOLD_GAVE_UP_TEXT;
}

export interface HoldInput {
  messageId: string;
  channelId: string;
  /** Wake hop id `d:<slug>:<messageId>`, for logs. */
  hop: string;
  sendUrl: string;
  request: SendPromptRequest;
}

export interface HeldHop extends HoldInput {
  seq: number;
  submittedAt: number;
  /** Wall ms after which a failed try gives up. */
  deadline: number;
  /** True once the hop is held and the user sees the holding status. */
  holding: boolean;
  holdStartedAt?: number;
  /** sendPrompt calls made for this hop. */
  tries: number;
  /** Failed tries in a row (drives backoff). */
  failures: number;
  statusMessageId?: string;
}

export interface HoldUi {
  /** Post or edit the holding status. Returns the status message id. */
  holding(hop: HeldHop): Promise<string | undefined>;
  /** sendPrompt answered. Continue the normal flow (✅ / ⚠️). */
  delivered(
    hop: HeldHop,
    result: SendPromptResponse,
    info: { held: boolean; elapsedMs: number },
  ): Promise<void>;
  /** Final failure. `held` hops show HOLD_GAVE_UP_TEXT; unheld ones just get ❌. */
  failed(
    hop: HeldHop,
    err: unknown,
    info: { held: boolean; expired: boolean; elapsedMs: number },
  ): Promise<void>;
}

export interface HoldLog {
  info(line: string): void;
  warn(line: string): void;
}

export interface HoldQueueOptions {
  /** JSON backup path. Empty string = memory only. */
  filePath: string;
  /** Hold window in ms. 0 = no hold (first tunnel error is final). */
  maxMs: number;
  send(hop: HeldHop): Promise<SendPromptResponse>;
  ui: HoldUi;
  log?: HoldLog;
  now?: () => number;
  /** Optional wake hook (0.2.12). Called on held hops, success, and when nothing is held. */
  wake?: HoldWakeHook;
}

interface HoldFile {
  version: 1;
  hops: HeldHop[];
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function secs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

export class SendPromptHoldQueue {
  private readonly lanes = new Map<string, HeldHop[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly busy = new Set<string>();
  private seq = 0;
  private wroteEntries = false;
  private lastWriteError = "";
  private readonly log: HoldLog;
  private readonly now: () => number;
  private readonly wake: HoldWakeHook;

  constructor(private readonly opts: HoldQueueOptions) {
    this.wake = opts.wake ?? NO_WAKE;
    this.log = opts.log ?? {
      info: (l) => console.log(l),
      warn: (l) => console.warn(l),
    };
    this.now = opts.now ?? (() => Date.now());
  }

  /** True when this channel has a hop waiting or in flight. */
  hasLane(channelId: string): boolean {
    return (this.lanes.get(channelId)?.length ?? 0) > 0;
  }

  /** All hops, oldest first. */
  snapshot(): HeldHop[] {
    return [...this.lanes.values()].flat().sort((a, b) => a.seq - b.seq);
  }

  /**
   * Send now, or wait behind an earlier hop from the same channel.
   * Resolves after the first try (or after queuing behind).
   */
  async submit(input: HoldInput): Promise<void> {
    const now = this.now();
    const hop: HeldHop = {
      ...input,
      seq: ++this.seq,
      submittedAt: now,
      deadline: now + this.opts.maxMs,
      holding: false,
      tries: 0,
      failures: 0,
    };
    const lane = this.lanes.get(hop.channelId) ?? [];
    lane.push(hop);
    this.lanes.set(hop.channelId, lane);
    if (lane.length === 1) {
      await this.attempt(hop.channelId);
      return;
    }
    if (lane[0].holding) {
      await this.startHold(hop, "behind earlier held message");
    }
  }

  /** Reload unexpired hops from the backup file and replay them. Expired ones get the red X. */
  async load(): Promise<void> {
    const path = this.opts.filePath;
    if (!path) return;
    let parsed: HoldFile | undefined;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as HoldFile;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        this.log.warn(`[sendPrompt] hold file unreadable path=${path} err=${errText(err)}`);
      }
      return;
    }
    const hops = Array.isArray(parsed?.hops) ? parsed.hops : [];
    const now = this.now();
    const expired: HeldHop[] = [];
    for (const hop of hops.sort((a, b) => a.seq - b.seq)) {
      if (!hop?.messageId || !hop.channelId || !hop.sendUrl || !hop.request) continue;
      this.seq = Math.max(this.seq, hop.seq);
      if (now >= hop.deadline) {
        expired.push(hop);
        continue;
      }
      const lane = this.lanes.get(hop.channelId) ?? [];
      lane.push({ ...hop, holding: true, holdStartedAt: hop.holdStartedAt ?? hop.submittedAt });
      this.lanes.set(hop.channelId, lane);
    }
    this.persist();
    this.log.info(
      `[sendPrompt] hold reload kept=${this.snapshot().length} expired=${expired.length}`,
    );
    for (const hop of expired) {
      this.log.warn(
        `[sendPrompt] hold gave up after ${secs(now - (hop.holdStartedAt ?? hop.submittedAt))}s msg=${hop.messageId} ch=${hop.channelId} tries=${hop.tries} reason=expired_while_down`,
      );
      await this.opts.ui
        .failed(hop, new Error("hold expired"), {
          held: true,
          expired: true,
          elapsedMs: now - hop.submittedAt,
        })
        .catch(() => undefined);
    }
    for (const [channelId, lane] of this.lanes) {
      for (const hop of lane) {
        if (!hop.statusMessageId) await this.showHolding(hop);
      }
      this.schedule(channelId, 0);
    }
  }

  /** Clear timers (tests / shutdown). Hops stay in the backup file. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(channelId: string, delayMs: number): void {
    const prev = this.timers.get(channelId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(channelId);
      void this.attempt(channelId);
    }, Math.max(0, delayMs));
    this.timers.set(channelId, t);
  }

  private scheduleHead(channelId: string): void {
    const head = this.lanes.get(channelId)?.[0];
    if (!head) {
      this.lanes.delete(channelId);
      return;
    }
    const wait = holdRetryDelayMs(head.failures);
    const left = head.deadline - this.now();
    this.schedule(channelId, head.failures > 0 ? Math.min(wait, Math.max(0, left)) : 0);
  }

  private async showHolding(hop: HeldHop): Promise<void> {
    try {
      const id = await this.opts.ui.holding(hop);
      if (id) hop.statusMessageId = id;
    } catch (err) {
      this.log.warn(`[sendPrompt] hold status failed msg=${hop.messageId} err=${errText(err)}`);
    }
    this.persist();
  }

  private async startHold(hop: HeldHop, reason: string): Promise<void> {
    if (hop.holding) return;
    hop.holding = true;
    hop.holdStartedAt = this.now();
    this.persist();
    this.log.warn(
      `[sendPrompt] hold start msg=${hop.messageId} ch=${hop.channelId} hop=${hop.hop} maxSec=${Math.round(this.opts.maxMs / 1000)} reason=${reason}`,
    );
    await this.showHolding(hop);
  }

  private async finish(channelId: string, hop: HeldHop): Promise<void> {
    const lane = this.lanes.get(channelId);
    if (lane && lane[0] === hop) lane.shift();
    if (lane && lane.length === 0) this.lanes.delete(channelId);
    this.persist();
  }

  private async attempt(channelId: string): Promise<void> {
    const hop = this.lanes.get(channelId)?.[0];
    if (!hop || this.busy.has(channelId)) return;
    this.busy.add(channelId);
    try {
      if (hop.holding) {
        this.log.info(
          `[sendPrompt] hold retry n=${hop.tries + 1} msg=${hop.messageId} ch=${hop.channelId} heldSec=${secs(this.now() - (hop.holdStartedAt ?? hop.submittedAt))}`,
        );
      }
      hop.tries += 1;
      let result: SendPromptResponse;
      try {
        result = await this.opts.send(hop);
      } catch (err) {
        await this.onError(channelId, hop, err);
        return;
      }
      const now = this.now();
      await this.finish(channelId, hop);
      this.callWake(() => this.wake.succeeded());
      if (hop.holding) {
        this.log.info(
          `[sendPrompt] hold success after ${secs(now - (hop.holdStartedAt ?? hop.submittedAt))}s msg=${hop.messageId} ch=${hop.channelId} tries=${hop.tries}`,
        );
      }
      await this.opts.ui
        .delivered(hop, result, { held: hop.holding, elapsedMs: now - hop.submittedAt })
        .catch(() => undefined);
    } finally {
      this.busy.delete(channelId);
    }
    this.scheduleHead(channelId);
  }

  private async onError(channelId: string, hop: HeldHop, err: unknown): Promise<void> {
    const now = this.now();
    const retryable = isHoldRetryableSendError(err);
    hop.failures += 1;
    if (retryable && now < hop.deadline) {
      if (!hop.holding) {
        await this.startHold(hop, errText(err).replace(/\s+/g, "_").slice(0, 80));
        // Later hops from this channel are held too, in order.
        for (const behind of this.lanes.get(channelId)?.slice(1) ?? []) {
          await this.startHold(behind, "behind earlier held message");
        }
      } else {
        this.persist();
      }
      this.notifyHeld(err);
      this.busy.delete(channelId);
      this.scheduleHead(channelId);
      return;
    }
    await this.finish(channelId, hop);
    if (!this.snapshot().some((h) => h.holding)) this.callWake(() => this.wake.idle());
    if (hop.holding) {
      this.log.warn(
        `[sendPrompt] hold gave up after ${secs(now - (hop.holdStartedAt ?? hop.submittedAt))}s msg=${hop.messageId} ch=${hop.channelId} tries=${hop.tries} reason=${retryable ? "window_expired" : "rejected"} err=${errText(err)}`,
      );
    } else {
      console.error(`[sendPrompt] failed msg=${hop.messageId} err=${errText(err)}`);
    }
    await this.opts.ui
      .failed(hop, err, {
        held: hop.holding,
        expired: retryable,
        elapsedMs: now - hop.submittedAt,
      })
      .catch(() => undefined);
    this.busy.delete(channelId);
    this.scheduleHead(channelId);
  }

  /** Tell the wake hook a hop is held. Counts and times only; never hop content. */
  private notifyHeld(err: unknown): void {
    const held = this.snapshot().filter((h) => h.holding);
    if (held.length === 0) return;
    const firstHeldAt = Math.min(...held.map((h) => h.holdStartedAt ?? h.submittedAt));
    this.callWake(() => this.wake.held({ err, heldCount: held.length, firstHeldAt }));
  }

  /** The wake hook must never break or delay the hold loop. */
  private callWake(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.warn(`[sendPrompt] wake hook error err=${err instanceof Error ? err.name : typeof err}`);
    }
  }

  /** Mirror held hops to disk (atomic rename). Unheld in-flight hops are not written. */
  private persist(): void {
    const path = this.opts.filePath;
    if (!path) return;
    const hops = this.snapshot().filter((h) => h.holding);
    if (hops.length === 0 && !this.wroteEntries) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const data: HoldFile = { version: 1, hops };
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, path);
      this.wroteEntries = hops.length > 0;
      this.lastWriteError = "";
    } catch (err) {
      const text = errText(err);
      if (text !== this.lastWriteError) {
        this.log.warn(`[sendPrompt] hold file write failed path=${path} err=${text} (memory only)`);
        this.lastWriteError = text;
      }
    }
  }
}
