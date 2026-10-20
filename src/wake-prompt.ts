import type { WakeAttachmentRef } from "./attachments.js";
import type { WakeIdentity } from "./user-directory.js";

/**
 * Wake prompt formats (0.2.14).
 *
 * - `compact` (default): one human header line, the message text, and one
 *   trailing routing line that starts with TRAILER_MARK. See README
 *   "Inbound wake" for the grammar.
 * - `legacy`: the 0.2.13 shape: `d:<slug>:<msgId>` line, thin JSON, text.
 *
 * Selected with WAKE_PROMPT_FORMAT=compact|legacy. sendPrompt `metadata` is
 * sent the same way in both formats.
 */
export type WakePromptFormat = "compact" | "legacy";

export const DEFAULT_WAKE_PROMPT_FORMAT: WakePromptFormat = "compact";

/** U+27C2 PERPENDICULAR. Never typed in normal chat, no Markdown meaning. */
export const TRAILER_MARK = "\u27C2";

export function parseWakePromptFormat(raw: string | undefined): {
  format: WakePromptFormat;
  valid: boolean;
} {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { format: DEFAULT_WAKE_PROMPT_FORMAT, valid: true };
  if (v === "compact" || v === "legacy") return { format: v, valid: true };
  return { format: DEFAULT_WAKE_PROMPT_FORMAT, valid: false };
}

export interface WakePromptArgs {
  slug: string;
  messageId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  userTag: string;
  alias: string;
  cleaned: string;
  attachments?: WakeAttachmentRef[];
  /** Optional sender identity from the user directory (0.2.11). */
  who?: WakeIdentity;
  /** Guild channel or thread name for the compact header. Falls back to slug. */
  channelName?: string;
}

/**
 * Legacy wake prompt: `d:<slug>:<message.id>`, thin JSON
 * `{id,g,u,un?,dn?,lb?,c?,map,a?}`, human text.
 */
export function formatLegacyWakePrompt(args: WakePromptArgs): string {
  const plugId = `d:${args.slug}:${args.messageId}`;
  const thinObj: Record<string, unknown> = {
    id: plugId,
    g: args.guildId,
    u: args.userId,
    map: args.alias,
  };
  // Optional identity next to `u`: username, display name, operator label.
  // Readers must cope with any of them missing.
  if (args.who?.un) thinObj.un = args.who.un;
  if (args.who?.dn) thinObj.dn = args.who.dn;
  if (args.who?.lb) thinObj.lb = args.who.lb;
  // Optional `c`: Discord channel snowflake (DMs too) so replies can target it directly.
  if (args.channelId) thinObj.c = args.channelId;
  if (args.attachments && args.attachments.length > 0) {
    // Short key `a` keeps the thin envelope small; URL refs only (no base64).
    thinObj.a = args.attachments.map((r) => {
      const item: Record<string, unknown> = { url: r.url };
      if (r.filename) item.filename = r.filename;
      if (r.contentType) item.contentType = r.contentType;
      if (typeof r.size === "number") item.size = r.size;
      return item;
    });
  }
  const thin = JSON.stringify(thinObj);
  return [plugId, thin, args.cleaned].join("\n");
}

/** One line, no control characters, trimmed and capped. */
function oneLine(s: string, max = 80): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Display label: operator label, else display name, else username/tag, else id. */
export function wakeLabel(args: Pick<WakePromptArgs, "who" | "userTag" | "userId">): string {
  for (const c of [args.who?.lb, args.who?.dn, args.who?.un, args.userTag]) {
    const v = oneLine(c ?? "");
    if (v) return v;
  }
  return `user ${args.userId}`;
}

/** Trailer `map` value: `%`, whitespace and controls are percent-encoded. */
function trailerValue(v: string): string {
  return v.replace(/[%\s\u0000-\u001f\u007f]/g, (ch) => encodeURIComponent(ch));
}

/** Attachment URLs go in as-is (already URL-encoded); only stray whitespace becomes %20. */
function trailerUrl(v: string): string {
  return v.replace(/\s/g, "%20");
}

export function formatWakeTrailer(args: WakePromptArgs): string {
  const parts = [TRAILER_MARK, `d:${args.slug}:${args.messageId}`, `u=${args.userId}`];
  if (args.channelId) parts.push(`c=${args.channelId}`);
  if (args.guildId) parts.push(`g=${args.guildId}`);
  if (args.alias) parts.push(`map=${trailerValue(args.alias)}`);
  for (const r of args.attachments ?? []) parts.push(`a=${trailerUrl(r.url)}`);
  return parts.join(" ");
}

/**
 * Compact wake prompt:
 *
 *   Discord DM from <label>: <text>
 *   Discord #<channel> from <label>: <text>
 *   ⟂ d:<slug>:<msgId> u=<userId> c=<channelId> [g=<guildId>] [map=<alias>] [a=<url>]...
 */
export function formatCompactWakePrompt(args: WakePromptArgs): string {
  const where = args.guildId
    ? `#${oneLine(args.channelName || args.slug, 100) || args.slug}`
    : "DM";
  const n = args.attachments?.length ?? 0;
  const att = n > 0 ? ` (${n} attachment${n === 1 ? "" : "s"})` : "";
  const header = `Discord ${where} from ${wakeLabel(args)}${att}:`;
  const body = args.cleaned ? `${header} ${args.cleaned}` : header;
  return `${body}\n${formatWakeTrailer(args)}`;
}

export function formatWakePrompt(
  args: WakePromptArgs,
  format: WakePromptFormat = "legacy",
): string {
  return format === "compact" ? formatCompactWakePrompt(args) : formatLegacyWakePrompt(args);
}

export interface ParsedWakeTrailer {
  hop: string;
  slug: string;
  messageId: string;
  userId: string;
  channelId?: string;
  guildId?: string;
  map?: string;
  attachments: string[];
}

const TRAILER_RE = /^\u27C2 d:(\S+):(\d+)((?: [a-z]+=\S*)*)$/;

/**
 * Reference parser for the compact trailer (the last line of the prompt).
 * Returns null when the last line is not a trailer. Unknown keys are ignored.
 */
export function parseWakeTrailer(prompt: string): ParsedWakeTrailer | null {
  const lines = prompt.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const m = TRAILER_RE.exec(lines[lines.length - 1] ?? "");
  if (!m) return null;
  const out: ParsedWakeTrailer = {
    hop: `d:${m[1]}:${m[2]}`,
    slug: m[1],
    messageId: m[2],
    userId: "",
    attachments: [],
  };
  for (const tok of m[3].trim().split(" ").filter(Boolean)) {
    const eq = tok.indexOf("=");
    const key = tok.slice(0, eq);
    const raw = tok.slice(eq + 1);
    let val = raw;
    if (key === "map") {
      try {
        val = decodeURIComponent(raw);
      } catch {
        /* keep raw */
      }
    }
    if (key === "u") out.userId = val;
    else if (key === "c") out.channelId = val;
    else if (key === "g") out.guildId = val;
    else if (key === "map") out.map = val;
    else if (key === "a") out.attachments.push(raw);
  }
  return out.userId ? out : null;
}
