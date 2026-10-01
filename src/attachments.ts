/** Shared attachment limits + helpers for callback outbound and inbound wake refs. */

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB
export const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

export const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
  "text/plain",
]);

export type AttachmentErrorCode =
  | "attachment_too_large"
  | "too_many_attachments"
  | "unsupported_media_type"
  | "attachment_fetch_failed"
  | "content_or_attachment_required"
  | "invalid_attachment"
  | "invalid_attachment_url";

export class AttachmentError extends Error {
  constructor(
    public readonly code: AttachmentErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AttachmentError";
  }
}

export interface ResolvedAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface WakeAttachmentRef {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

export interface JsonAttachmentInput {
  filename?: string;
  contentType?: string;
  data?: string;
  url?: string;
}

function stripDataUrlPrefix(data: string): string {
  const m = /^data:[^;]+;base64,(.+)$/i.exec(data.trim());
  return m ? m[1] : data.trim();
}

function guessMimeFromFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp3") || lower.endsWith(".mpeg")) return "audio/mpeg";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt")) return "text/plain";
  return undefined;
}

function normalizeMime(raw: string | undefined, filename: string): string {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (base && ALLOWED_MIME.has(base)) return base;
  // jpeg alias
  if (base === "image/jpg") return "image/jpeg";
  const guessed = guessMimeFromFilename(filename);
  if (guessed) return guessed;
  return base || "application/octet-stream";
}

export function assertMimeAllowed(contentType: string): void {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(base)) {
    throw new AttachmentError("unsupported_media_type", `mime ${base}`);
  }
}

function safeFilename(name: string | undefined, fallback: string): string {
  const raw = (name ?? fallback).trim() || fallback;
  // Discord-safe: strip path separators / control chars
  return raw.replace(/[/\\:\0<>|"?*]/g, "_").slice(0, 200) || fallback;
}

function filenameFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last).slice(0, 200);
  } catch {
    /* ignore */
  }
  return "attachment.bin";
}

export function decodeBase64Attachment(input: JsonAttachmentInput): ResolvedAttachment {
  if (typeof input.data !== "string" || !input.data.trim()) {
    throw new AttachmentError("invalid_attachment", "data required");
  }
  if (typeof input.filename !== "string" || !input.filename.trim()) {
    throw new AttachmentError("invalid_attachment", "filename required for data");
  }
  const filename = safeFilename(input.filename, "file.bin");
  let buffer: Buffer;
  try {
    buffer = Buffer.from(stripDataUrlPrefix(input.data), "base64");
  } catch {
    throw new AttachmentError("invalid_attachment", "invalid base64");
  }
  if (buffer.length === 0) {
    throw new AttachmentError("invalid_attachment", "empty data");
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("attachment_too_large");
  }
  const contentType = normalizeMime(input.contentType, filename);
  assertMimeAllowed(contentType);
  return { filename, contentType, buffer };
}

export async function fetchUrlAttachment(
  input: JsonAttachmentInput,
): Promise<ResolvedAttachment> {
  if (typeof input.url !== "string" || !input.url.trim()) {
    throw new AttachmentError("invalid_attachment", "url required");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw new AttachmentError("invalid_attachment_url", "url parse failed");
  }
  if (parsed.protocol !== "https:") {
    throw new AttachmentError("invalid_attachment_url", "https only");
  }

  const filename = safeFilename(
    input.filename ?? filenameFromUrl(input.url),
    "attachment.bin",
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: { accept: "*/*" },
    });
    if (!res.ok) {
      throw new AttachmentError(
        "attachment_fetch_failed",
        `HTTP ${res.status}`,
      );
    }
    const headerMime = res.headers.get("content-type") ?? undefined;
    const contentType = normalizeMime(
      input.contentType ?? headerMime,
      filename,
    );
    assertMimeAllowed(contentType);

    const lenHeader = res.headers.get("content-length");
    if (lenHeader) {
      const n = Number(lenHeader);
      if (Number.isFinite(n) && n > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentError("attachment_too_large");
      }
    }

    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length === 0) {
      throw new AttachmentError("attachment_fetch_failed", "empty body");
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachment_too_large");
    }
    return { filename, contentType, buffer };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(
      "attachment_fetch_failed",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveJsonAttachments(
  items: JsonAttachmentInput[] | undefined,
): Promise<ResolvedAttachment[]> {
  if (!items || items.length === 0) return [];
  if (items.length > MAX_ATTACHMENTS) {
    throw new AttachmentError("too_many_attachments");
  }
  const out: ResolvedAttachment[] = [];
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new AttachmentError("invalid_attachment");
    }
    const hasData = typeof item.data === "string" && item.data.length > 0;
    const hasUrl = typeof item.url === "string" && item.url.length > 0;
    if (hasData === hasUrl) {
      // both or neither
      throw new AttachmentError(
        "invalid_attachment",
        "each attachment needs exactly one of data or url",
      );
    }
    const resolved = hasData
      ? decodeBase64Attachment(item)
      : await fetchUrlAttachment(item);
    total += resolved.buffer.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachment_too_large", "total exceeds 25 MiB");
    }
    out.push(resolved);
  }
  return out;
}

export function resolveMultipartFiles(
  files: Array<{
    fieldname: string;
    originalname: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
  }>,
): ResolvedAttachment[] {
  const picked = files.filter(
    (f) => f.fieldname === "files" || f.fieldname === "files[]",
  );
  if (picked.length > MAX_ATTACHMENTS) {
    throw new AttachmentError("too_many_attachments");
  }
  const out: ResolvedAttachment[] = [];
  let total = 0;
  for (const f of picked) {
    if (f.size > MAX_ATTACHMENT_BYTES || f.buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachment_too_large");
    }
    const filename = safeFilename(f.originalname, "upload.bin");
    const contentType = normalizeMime(f.mimetype, filename);
    assertMimeAllowed(contentType);
    total += f.buffer.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachment_too_large", "total exceeds 25 MiB");
    }
    out.push({ filename, contentType, buffer: f.buffer });
  }
  return out;
}

/** Build thin-wake attachment refs from a Discord.js message.attachments collection. */
export function wakeAttachmentRefsFromDiscord(message: {
  attachments: { size: number; values: () => IterableIterator<{
    url: string;
    proxyURL?: string;
    name: string | null;
    contentType: string | null;
    size: number;
  }> };
}): WakeAttachmentRef[] {
  if (!message.attachments?.size) return [];
  const refs: WakeAttachmentRef[] = [];
  for (const att of message.attachments.values()) {
    const url = att.url || att.proxyURL;
    if (!url) continue;
    const ref: WakeAttachmentRef = { url };
    if (att.name) ref.filename = att.name;
    if (att.contentType) ref.contentType = att.contentType;
    if (typeof att.size === "number") ref.size = att.size;
    refs.push(ref);
    if (refs.length >= MAX_ATTACHMENTS) break;
  }
  return refs;
}
