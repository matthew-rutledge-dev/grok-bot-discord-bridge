import { SendPromptHttpError } from "./grok-client.js";

/**
 * Optional wake hook for sendPrompt holds (0.2.12).
 *
 * The 0.2.10 hold only helps if the Grok Bot computer wakes on its own inside
 * SENDPROMPT_HOLD_MAX_SEC. A computer that hibernates for hours never does, so
 * the hold runs out and the message gets the red X.
 *
 * When SENDPROMPT_WAKE_URL is set, the first time a hop is held on a retryable
 * tunnel error the bridge POSTs once to that URL (for example a Grok Bot
 * routine webhook) so something can wake the computer while the hop is still
 * held. The body is only `{ reason, heldCount, firstHeldAt }`: no tokens, no
 * message content, no user ids, no channel ids or names.
 *
 * At most one POST per outage. The hook re-arms after the next successful
 * sendPrompt, or once no hop is held any more (every held hop gave up), so a
 * later outage can wake the computer again. The POST is fire-and-forget with a
 * short timeout: it never blocks, delays, or breaks the hold/retry loop, and a
 * failure is logged without the key or the URL.
 */

export const DEFAULT_WAKE_HEADER = "Authorization";
export const DEFAULT_WAKE_TIMEOUT_MS = 5_000;

export interface WakeBody {
  /** Short code such as `http_530`, `tunnel_1033`, `http_502`, `network`. */
  reason: string;
  /** Hops currently held (all channels). */
  heldCount: number;
  /** ISO time the oldest currently held hop started holding. */
  firstHeldAt: string;
}

export interface WakeHeldEvent {
  err: unknown;
  heldCount: number;
  firstHeldAt: number;
}

/** What the hold queue calls. Every method must be safe to call often. */
export interface HoldWakeHook {
  /** A hop is held (or still held) after a retryable tunnel error. */
  held(event: WakeHeldEvent): void;
  /** sendPrompt answered. The computer is reachable: re-arm. */
  succeeded(): void;
  /** No hop is held any more (all gave up or were rejected): re-arm. */
  idle(): void;
}

export interface WakeLog {
  info(line: string): void;
  warn(line: string): void;
}

export interface WakeHookOptions {
  /** Blank = off. */
  url: string;
  /** Blank = no auth header. Never logged. */
  key: string;
  /**
   * Header that carries the key. `Authorization` (default, case-insensitive)
   * sends `Authorization: Bearer <key>`. Any other name sends the raw key,
   * e.g. `X-Webhook-Key: <key>`.
   */
  header?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: WakeLog;
}

/** Short, content-free reason code for the wake body and logs. */
export function wakeReason(err: unknown): string {
  if (err instanceof SendPromptHttpError) {
    if (/\b1033\b/.test(err.body) || /\b1033\b/.test(err.message)) return "tunnel_1033";
    return `http_${err.status}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b1033\b/.test(msg)) return "tunnel_1033";
  const m = /HTTP (\d{3})/.exec(msg);
  if (m) return `http_${m[1]}`;
  return "network";
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Header name and value for the key. Exported for tests. */
export function wakeAuthHeader(
  header: string | undefined,
  key: string,
): { name: string; value: string } | undefined {
  if (!key) return undefined;
  const name = (header ?? "").trim() || DEFAULT_WAKE_HEADER;
  if (!HEADER_NAME.test(name) || name.toLowerCase() === "authorization") {
    return { name: DEFAULT_WAKE_HEADER, value: `Bearer ${key}` };
  }
  return { name, value: key };
}

/** Error class / code only. Never the message: it can echo the URL. */
function safeErr(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const name = typeof e?.name === "string" ? e.name : typeof err;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `${name}/${code}` : name;
}

export class SendPromptWakeHook implements HoldWakeHook {
  readonly enabled: boolean;
  private fired = false;
  private readonly url: URL | undefined;
  private readonly auth: { name: string; value: string } | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: WakeLog;
  /** The last POST (tests). */
  lastPost: Promise<void> = Promise.resolve();

  constructor(opts: WakeHookOptions) {
    this.log = opts.log ?? {
      info: (l) => console.log(l),
      warn: (l) => console.warn(l),
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs =
      opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_WAKE_TIMEOUT_MS;
    const raw = opts.url.trim();
    let url: URL | undefined;
    if (raw) {
      try {
        url = new URL(raw);
        if (url.protocol !== "https:" && url.protocol !== "http:") url = undefined;
      } catch {
        url = undefined;
      }
      if (!url) this.log.warn("[sendPrompt] wake hook off: SENDPROMPT_WAKE_URL is not an http(s) URL");
    }
    this.url = url;
    this.enabled = url !== undefined;
    this.auth = wakeAuthHeader(opts.header, opts.key);
    if (this.enabled && !this.auth) {
      this.log.warn("[sendPrompt] wake hook on without SENDPROMPT_WAKE_KEY (no auth header)");
    }
  }

  /** True when the next held hop would send a wake (on, and not yet sent this outage). */
  get armed(): boolean {
    return this.enabled && !this.fired;
  }

  /** Startup log line. Host only; the path can carry a webhook secret. */
  describe(): string {
    if (!this.enabled || !this.url) return "[sendPrompt] wake hook off";
    return `[sendPrompt] wake hook on host=${this.url.host} header=${this.auth?.name ?? "none"} timeoutMs=${this.timeoutMs}`;
  }

  held(event: WakeHeldEvent): void {
    if (!this.enabled || this.fired || !this.url) return;
    this.fired = true;
    const body: WakeBody = {
      reason: wakeReason(event.err),
      heldCount: Math.max(1, Math.floor(event.heldCount)),
      firstHeldAt: new Date(event.firstHeldAt).toISOString(),
    };
    this.lastPost = this.post(this.url, body);
  }

  succeeded(): void {
    this.rearm("success");
  }

  idle(): void {
    this.rearm("no_held_hops");
  }

  private rearm(why: string): void {
    if (!this.fired) return;
    this.fired = false;
    this.log.info(`[sendPrompt] wake hook re-armed reason=${why}`);
  }

  private async post(url: URL, body: WakeBody): Promise<void> {
    const started = Date.now();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.auth) headers[this.auth.name] = this.auth.value;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      // Drain without reading it into logs.
      await res.body?.cancel().catch(() => undefined);
      const ms = Date.now() - started;
      if (res.ok) {
        this.log.info(
          `[sendPrompt] wake sent status=${res.status} reason=${body.reason} heldCount=${body.heldCount} ms=${ms}`,
        );
      } else {
        this.log.warn(
          `[sendPrompt] wake failed status=${res.status} reason=${body.reason} ms=${ms} (hold continues)`,
        );
      }
    } catch (err) {
      this.log.warn(
        `[sendPrompt] wake failed err=${safeErr(err)} reason=${body.reason} ms=${Date.now() - started} (hold continues)`,
      );
    }
  }
}

/** A hook that does nothing (wake off). */
export const NO_WAKE: HoldWakeHook = {
  held: () => undefined,
  succeeded: () => undefined,
  idle: () => undefined,
};
