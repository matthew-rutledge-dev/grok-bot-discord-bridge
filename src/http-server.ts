import express, { type Express, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import {
  AttachmentBuilder,
  type Client,
  type TextBasedChannel,
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { CallbackPayload } from "./types.js";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  resolveJsonAttachments,
  resolveMultipartFiles,
  type ResolvedAttachment,
} from "./attachments.js";
import {
  elapsedMs,
  logTiming,
  monoMs,
  takeIdleGapMs,
} from "./timing.js";
import {
  SlidingWindowRateLimiter,
  hashIdentity,
} from "./rate-limit.js";

const DISCORD_MAX = 1900;
/** Prefer multipart for large binaries; JSON base64 path capped ~12 MiB. */
const JSON_BODY_LIMIT = "12mb";

function chunkText(text: string, max = DISCORD_MAX): string[] {
  if (!text) return [];
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** How the callback token was supplied. Prefer bearer / x-callback-token over ?token=. */
export type CallbackAuthSource = "bearer" | "header" | "query";

export interface CallbackAuth {
  token?: string;
  source?: CallbackAuthSource;
}

/**
 * Extract callback token. Header auth wins over query.
 * Prefer Authorization: Bearer or x-callback-token; ?token= still accepted.
 */
export function extractCallbackAuth(req: Request): CallbackAuth {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return { token, source: "bearer" };
  }
  const h = req.header("x-callback-token")?.trim();
  if (h) return { token: h, source: "header" };
  const q = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (q) return { token: q, source: "query" };
  return {};
}

/** @deprecated use extractCallbackAuth */
function extractToken(req: Request): string | undefined {
  return extractCallbackAuth(req).token;
}

/** Once-per-identity, then at most every 15m — recommend headers when ?token= used. */
const queryTokenWarnAt = new Map<string, number>();
const QUERY_TOKEN_WARN_COOLDOWN_MS = 15 * 60 * 1000;

export function warnQueryTokenAuth(tokenHash: string, now = Date.now()): boolean {
  const prev = queryTokenWarnAt.get(tokenHash);
  if (prev !== undefined && now - prev < QUERY_TOKEN_WARN_COOLDOWN_MS) {
    return false;
  }
  queryTokenWarnAt.set(tokenHash, now);
  console.warn(
    `[callback] auth via ?token= query (id=${tokenHash}); prefer Authorization: Bearer or x-callback-token`,
  );
  return true;
}

/** Test helper */
export function clearQueryTokenWarnState(): void {
  queryTokenWarnAt.clear();
}

function clientIp(req: Request): string {
  const xf = req.header("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || req.ip || "unknown";
}

function attachmentHttpStatus(code: string): number {
  switch (code) {
    case "unsupported_media_type":
      return 415;
    case "attachment_too_large":
    case "too_many_attachments":
    case "content_or_attachment_required":
    case "invalid_attachment":
    case "invalid_attachment_url":
      return 400;
    case "attachment_fetch_failed":
      return 502;
    default:
      return 400;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_ATTACHMENTS,
    fileSize: MAX_ATTACHMENT_BYTES,
    // field size for text fields stays small; binary is in files
    fieldSize: 256 * 1024,
  },
});

function maybeMultipart(req: Request, res: Response, next: NextFunction): void {
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("multipart/form-data")) {
    next();
    return;
  }
  upload.any()(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const e = err as { code?: string; message?: string };
    if (e.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "attachment_too_large" });
      return;
    }
    if (e.code === "LIMIT_FILE_COUNT" || e.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(400).json({ error: "too_many_attachments" });
      return;
    }
    console.error("[callback] multer error:", e.message ?? err);
    res.status(400).json({ error: "invalid_attachment" });
  });
}

async function deliverToChannel(args: {
  channel: TextBasedChannel;
  content: string;
  replyToMessageId?: string;
  files: ResolvedAttachment[];
}): Promise<{ messageId: string | undefined; chunks: number }> {
  const { channel, content, replyToMessageId, files } = args;
  const chunks = chunkText(content);
  // discord.js AttachmentBuilder: name drives extension/MIME; we already validated mime.
  const builders = files.map(
    (f) => new AttachmentBuilder(f.buffer, { name: f.filename }),
  );

  // Attachment-only: one message with files, no text.
  if (chunks.length === 0) {
    const sent = await (channel as {
      send: (p: unknown) => Promise<{ id: string }>;
    }).send({
      files: builders,
      ...(replyToMessageId
        ? { reply: { messageReference: replyToMessageId } }
        : {}),
    });
    return { messageId: sent.id, chunks: 1 };
  }

  let firstId: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const payload: Record<string, unknown> = { content: chunks[i] };
    if (isFirst && builders.length) payload.files = builders;
    if (isFirst && replyToMessageId) {
      payload.reply = { messageReference: replyToMessageId };
    }
    const sent = await (channel as {
      send: (p: unknown) => Promise<{ id: string }>;
    }).send(payload);
    if (!firstId) firstId = sent.id;
  }
  return { messageId: firstId, chunks: chunks.length };
}

export function createHttpServer(
  cfg: AppConfig,
  getDiscord: () => Client | null,
  opts?: { rateLimiter?: SlidingWindowRateLimiter },
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  const rateLimiter =
    opts?.rateLimiter ??
    new SlidingWindowRateLimiter(cfg.callbackRateLimitPerMin);
  if (rateLimiter.enabled) {
    console.log(
      `[http] callback soft rate limit ${rateLimiter.limit}/min (token hash + IP)`,
    );
  } else {
    console.log("[http] callback soft rate limit disabled");
  }

  app.get("/healthz", (_req, res) => {
    const discord = getDiscord();
    res.status(200).json({
      ok: true,
      service: "grok-bot-discord-bridge",
      discordReady: Boolean(discord?.isReady()),
      hasTokenConfigured: cfg.hasRealDiscordToken,
      callbackPath: cfg.callbackPath,
      callbackBaseUrl: cfg.callbackBaseUrl,
    });
  });

  const callbackPath = cfg.callbackPath.startsWith("/")
    ? cfg.callbackPath
    : `/${cfg.callbackPath}`;

  app.post(
    callbackPath,
    maybeMultipart,
    async (req: Request, res: Response) => {
      const tCallback = monoMs();
      if (!cfg.callbackToken) {
        res.status(503).json({ error: "callback_token_not_configured" });
        return;
      }
      const tAuth = monoMs();
      const { token, source } = extractCallbackAuth(req);
      if (!token || token !== cfg.callbackToken) {
        logTiming({
          stage: "callback_auth",
          ms: elapsedMs(tAuth),
          ok: false,
        });
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const tokenHash = hashIdentity(token);
      if (source === "query") {
        warnQueryTokenAuth(tokenHash);
      }

      // Soft rate limit after successful auth (keyed by token identity + client IP).
      if (rateLimiter.enabled) {
        const ip = clientIp(req);
        const tokenKey = `t:${tokenHash}`;
        const ipKey = `ip:${ip}`;
        const tokenPeek = rateLimiter.check(tokenKey, Date.now(), {
          record: false,
        });
        const ipPeek = rateLimiter.check(ipKey, Date.now(), { record: false });
        if (!tokenPeek.allowed || !ipPeek.allowed) {
          const denied = !tokenPeek.allowed ? tokenPeek : ipPeek;
          const which = !tokenPeek.allowed ? "token" : "ip";
          console.warn(
            `[callback] rate_limited which=${which} id=${tokenHash} ip=${ip} limit=${rateLimiter.limit}/min retry_after=${denied.retryAfterSec}`,
          );
          logTiming({
            stage: "callback_rate_limit",
            ms: elapsedMs(tAuth),
            ok: false,
          });
          res.setHeader("Retry-After", String(denied.retryAfterSec));
          res.status(429).json({
            error: "rate_limited",
            retryAfterSec: denied.retryAfterSec,
          });
          return;
        }
        rateLimiter.check(tokenKey);
        rateLimiter.check(ipKey);
      }

      const authMs = elapsedMs(tAuth);
      // replyToMessageId known after body parse — re-emit auth with msg= below.

      const isMultipart = (req.headers["content-type"] ?? "").includes(
        "multipart/form-data",
      );

      let channelId: string | undefined;
      let content: string | undefined;
      let replyToMessageId: string | undefined;
      let files: ResolvedAttachment[] = [];

      const tResolve = monoMs();
      try {
        if (isMultipart) {
          const body = req.body as Record<string, unknown>;
          channelId =
            typeof body.channelId === "string" ? body.channelId : undefined;
          content =
            typeof body.content === "string" ? body.content : undefined;
          replyToMessageId =
            typeof body.replyToMessageId === "string"
              ? body.replyToMessageId
              : undefined;
          type Uploaded = {
            fieldname: string;
            originalname: string;
            mimetype: string;
            buffer: Buffer;
            size: number;
          };
          const uploaded = (req.files as Uploaded[] | undefined) ?? [];
          files = resolveMultipartFiles(uploaded);
        } else {
          const body = req.body as CallbackPayload;
          channelId = body?.channelId;
          content = typeof body?.content === "string" ? body.content : undefined;
          replyToMessageId = body?.replyToMessageId;
          files = await resolveJsonAttachments(body?.attachments);
        }
      } catch (err) {
        logTiming({
          msg: replyToMessageId,
          stage: "callback_auth",
          ms: authMs,
          ok: true,
        });
        logTiming({
          msg: replyToMessageId,
          stage: "callback_resolve",
          ms: elapsedMs(tResolve),
          attachments: files.length,
          ok: false,
        });
        logTiming({
          msg: replyToMessageId,
          stage: "callback_total",
          ms: elapsedMs(tCallback),
          ok: false,
        });
        if (err instanceof AttachmentError) {
          res.status(attachmentHttpStatus(err.code)).json({ error: err.code });
          return;
        }
        throw err;
      }

      const idleMs = takeIdleGapMs(replyToMessageId);
      logTiming({
        msg: replyToMessageId,
        stage: "callback_auth",
        ms: authMs,
        ok: true,
      });
      logTiming({
        msg: replyToMessageId,
        stage: "callback_resolve",
        ms: elapsedMs(tResolve),
        attachments: files.length,
        ok: true,
      });

      const trimmed = (content ?? "").trim();
      if (!trimmed && files.length === 0) {
        logTiming({
          msg: replyToMessageId,
          stage: "callback_total",
          ms: elapsedMs(tCallback),
          idle_ms: idleMs,
          ok: false,
        });
        res.status(400).json({ error: "content_or_attachment_required" });
        return;
      }
      if (!channelId) {
        logTiming({
          msg: replyToMessageId,
          stage: "callback_total",
          ms: elapsedMs(tCallback),
          idle_ms: idleMs,
          ok: false,
        });
        res.status(400).json({ error: "channelId_required" });
        return;
      }

      const discord = getDiscord();
      if (!discord?.isReady()) {
        logTiming({
          msg: replyToMessageId,
          stage: "callback_total",
          ms: elapsedMs(tCallback),
          idle_ms: idleMs,
          ok: false,
        });
        res.status(503).json({ error: "discord_not_ready" });
        return;
      }

      const tDeliver = monoMs();
      try {
        const channel = await discord.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          logTiming({
            msg: replyToMessageId,
            stage: "callback_deliver",
            ms: elapsedMs(tDeliver),
            ok: false,
          });
          logTiming({
            msg: replyToMessageId,
            stage: "callback_total",
            ms: elapsedMs(tCallback),
            idle_ms: idleMs,
            ok: false,
          });
          res.status(404).json({ error: "channel_not_found" });
          return;
        }
        const result = await deliverToChannel({
          channel: channel as TextBasedChannel,
          content: trimmed,
          replyToMessageId,
          files,
        });
        logTiming({
          msg: replyToMessageId,
          stage: "callback_deliver",
          ms: elapsedMs(tDeliver),
          ok: true,
          chunks: result.chunks,
          attachments: files.length,
        });
        logTiming({
          msg: replyToMessageId,
          stage: "callback_total",
          ms: elapsedMs(tCallback),
          idle_ms: idleMs,
          ok: true,
        });
        res.status(200).json({
          ok: true,
          messageId: result.messageId,
          chunks: result.chunks,
          attachments: files.length,
        });
      } catch (err) {
        logTiming({
          msg: replyToMessageId,
          stage: "callback_deliver",
          ms: elapsedMs(tDeliver),
          ok: false,
        });
        logTiming({
          msg: replyToMessageId,
          stage: "callback_total",
          ms: elapsedMs(tCallback),
          idle_ms: idleMs,
          ok: false,
        });
        if (err instanceof AttachmentError) {
          res.status(attachmentHttpStatus(err.code)).json({ error: err.code });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[callback] deliver failed:", msg);
        res.status(502).json({ error: "deliver_failed" });
      }
    },
  );

  return app;
}

export function listenHttp(
  app: Express,
  cfg: AppConfig,
): Promise<ReturnType<Express["listen"]>> {
  return new Promise((resolve, reject) => {
    const server = app.listen(cfg.httpPort, cfg.httpBind, () => {
      console.log(
        `[http] listening ${cfg.httpBind}:${cfg.httpPort} healthz=/healthz callback=${cfg.callbackPath}`,
      );
      resolve(server);
    });
    server.on("error", reject);
  });
}
