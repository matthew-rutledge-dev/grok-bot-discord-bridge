/**
 * Bottleneck-friendly structured stage timing.
 * One console line per stage: `[timing] msg=… hop=… stage=… ms=… …`
 * Never log tokens, Bearer headers, or message content.
 */

export type TimingValue = string | number | boolean | null | undefined;

const MAX_PENDING = 500;
const PENDING_TTL_MS = 30 * 60 * 1000;

/** Wall-clock map: inbound Discord messageId → sendPrompt-accepted time. */
const pendingAcceptedAt = new Map<string, number>();

function prunePending(now: number): void {
  if (pendingAcceptedAt.size <= MAX_PENDING) {
    for (const [id, t0] of pendingAcceptedAt) {
      if (now - t0 > PENDING_TTL_MS) pendingAcceptedAt.delete(id);
    }
    return;
  }
  // Drop oldest when over cap.
  const entries = [...pendingAcceptedAt.entries()].sort((a, b) => a[1] - b[1]);
  const drop = entries.length - Math.floor(MAX_PENDING / 2);
  for (let i = 0; i < drop; i++) pendingAcceptedAt.delete(entries[i][0]);
}

export function wallMs(): number {
  return Date.now();
}

/** High-resolution elapsed helper (ms, fractional). */
export function monoMs(): number {
  return performance.now();
}

export function elapsedMs(started: number): number {
  return Math.round(monoMs() - started);
}

function formatValue(v: string | number | boolean): string {
  if (typeof v === "string") {
    // Keep values single-token for grep-friendly lines.
    return v.replace(/\s+/g, "_").slice(0, 120);
  }
  return String(v);
}

/** Emit one `[timing]` line. Omits null/undefined/empty. */
export function logTiming(fields: Record<string, TimingValue>): void {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  console.log(`[timing] ${parts.join(" ")}`);
}

export function hopId(slug: string, messageId: string): string {
  return `d:${slug}:${messageId}`;
}

/** Record successful sendPrompt so callback can compute idle gap. */
export function markSendPromptAccepted(messageId: string): void {
  const now = wallMs();
  prunePending(now);
  pendingAcceptedAt.set(messageId, now);
}

/**
 * Idle ms from sendPrompt accept → callback (joined on replyToMessageId).
 * Consumes the pending entry when found.
 */
export function takeIdleGapMs(
  replyToMessageId: string | undefined,
): number | undefined {
  if (!replyToMessageId) return undefined;
  const t0 = pendingAcceptedAt.get(replyToMessageId);
  if (t0 === undefined) return undefined;
  pendingAcceptedAt.delete(replyToMessageId);
  return wallMs() - t0;
}

/** Test helper — clear pending map. */
export function clearPendingForTests(): void {
  pendingAcceptedAt.clear();
}
