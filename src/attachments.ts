/** Shared attachment limits + helpers for callback outbound and inbound wake refs. */

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB
export const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

export const ALLOWED_MIME = new Set([
  // images / media (existing)
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
  // office documents
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "text/csv",
  "text/tab-separated-values",
  // text / code
  "text/markdown",
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
  "text/x-python",
  "application/x-python",
  "text/x-shellscript",
  "application/x-sh",
  "application/x-powershell",
  "text/x-powershell",
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

/** Extension → MIME fallback when contentType is missing or application/octet-stream. */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yml": "application/x-yaml",
  ".yaml": "application/x-yaml",
  ".py": "text/x-python",
  ".ps1": "application/x-powershell",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
};

function guessMimeFromFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_MIME[lower.slice(dot)];
}

function normalizeMime(raw: string | undefined, filename: string): string {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  // Prefer allowlisted declared type (except opaque octet-stream → extension map).
  if (base && base !== "application/octet-stream" && ALLOWED_MIME.has(base)) {
    return base;
  }
  // jpeg alias
  if (base === "image/jpg") return "image/jpeg";
  const guessed = guessMimeFromFilename(filename);
  if (guessed) return guessed;
  if (base && ALLOWED_MIME.has(base)) return base;
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
