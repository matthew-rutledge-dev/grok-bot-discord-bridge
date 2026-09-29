import express, { type Express, type Request, type Response } from "express";
import type { Client, TextBasedChannel } from "discord.js";
import type { AppConfig } from "./config.js";
import type { CallbackPayload } from "./types.js";

const DISCORD_MAX = 1900;

function chunkText(text: string, max = DISCORD_MAX): string[] {
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

function extractToken(req: Request): string | undefined {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const h = req.header("x-callback-token");
  if (h) return h.trim();
  const q = typeof req.query.token === "string" ? req.query.token : undefined;
  return q?.trim();
}

export function createHttpServer(
  cfg: AppConfig,
  getDiscord: () => Client | null,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

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

  app.post(callbackPath, async (req: Request, res: Response) => {
    if (!cfg.callbackToken) {
      res.status(503).json({ error: "callback_token_not_configured" });
      return;
    }
    const token = extractToken(req);
    if (!token || token !== cfg.callbackToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = req.body as CallbackPayload;
    if (!body || typeof body.content !== "string" || !body.content.trim()) {
      res.status(400).json({ error: "content_required" });
      return;
    }
    if (!body.channelId) {
      res.status(400).json({ error: "channelId_required" });
      return;
    }

    const discord = getDiscord();
    if (!discord?.isReady()) {
      res.status(503).json({ error: "discord_not_ready" });
      return;
    }

    try {
      const channel = await discord.channels.fetch(body.channelId);
      if (!channel || !channel.isTextBased()) {
        res.status(404).json({ error: "channel_not_found" });
        return;
      }
      const textChannel = channel as TextBasedChannel;
      const chunks = chunkText(body.content);
      let firstId: string | undefined;
      for (let i = 0; i < chunks.length; i++) {
        const payload: { content: string; reply?: { messageReference: string } } = {
          content: chunks[i],
        };
        if (i === 0 && body.replyToMessageId) {
          const sent = await (textChannel as {
            send: (p: unknown) => Promise<{ id: string }>;
          }).send({
            content: chunks[i],
            reply: { messageReference: body.replyToMessageId },
          });
          firstId = sent.id;
        } else {
          const sent = await (textChannel as {
            send: (p: unknown) => Promise<{ id: string }>;
          }).send(payload);
          if (!firstId) firstId = sent.id;
        }
      }
      res.status(200).json({ ok: true, messageId: firstId, chunks: chunks.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[callback] deliver failed:", msg);
      res.status(502).json({ error: "deliver_failed" });
    }
  });

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
