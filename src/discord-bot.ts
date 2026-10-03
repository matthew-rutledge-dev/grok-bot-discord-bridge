import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
} from "discord.js";
import type { AppConfig } from "./config.js";
import { sendPrompt } from "./grok-client.js";
import { invokeLocalPlanner, isLocalPlannerRow, joinCallbackUrl } from "./local-planner.js";
import type { ChannelMapRow } from "./types.js";
import {
  authorizeDm,
  authorizeGuildMessage,
  isGuildOwner,
  pairUser,
  stripBotMention,
} from "./security.js";
import {
  wakeAttachmentRefsFromDiscord,
  type WakeAttachmentRef,
} from "./attachments.js";
import {
  elapsedMs,
  hopId,
  logTiming,
  markSendPromptAccepted,
  monoMs,
} from "./timing.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
}

/** Pure wake prompt: `d:<slug>:<message.id>`, thin JSON `{id,g,u,map,a?}`, human text. */
export function formatWakePrompt(args: {
  slug: string;
  messageId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  userTag: string;
  alias: string;
  cleaned: string;
  attachments?: WakeAttachmentRef[];
}): string {
  const plugId = `d:${args.slug}:${args.messageId}`;
  const thinObj: Record<string, unknown> = {
    id: plugId,
    g: args.guildId,
    u: args.userId,
    map: args.alias,
  };
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

function buildPrompt(
  message: Message,
  cleaned: string,
  opts: { slug: string; alias: string; attachments?: WakeAttachmentRef[] },
): string {
  return formatWakePrompt({
    slug: opts.slug,
    messageId: message.id,
    guildId: message.guild?.id ?? null,
    channelId: message.channelId,
    userId: message.author.id,
    userTag: message.author.tag,
    alias: opts.alias,
    cleaned,
    attachments: opts.attachments,
  });
}

export function wireDiscord(client: Client, cfg: AppConfig): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] ready as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    const t0 = monoMs();
    try {
      if (message.author.bot) return;

      // Owner pairing command in DM or guild: !pair <userId>
      const raw = message.content.trim();
      if (raw.startsWith("!pair ") && isGuildOwner(cfg, message.guild, message.author.id)) {
        const target = raw.slice(6).trim().replace(/[<@!>]/g, "");
        if (/^\d{5,}$/.test(target)) {
          pairUser(target);
          await message.reply(`paired ${target}`);
        }
        return;
      }
      if (
        !message.guild &&
        cfg.ownerId &&
        message.author.id === cfg.ownerId &&
        raw.startsWith("!pair ")
      ) {
        const target = raw.slice(6).trim().replace(/[<@!>]/g, "");
        if (/^\d{5,}$/.test(target)) {
          pairUser(target);
          await message.reply(`paired ${target}`);
        }
        return;
      }

      let agentId: string | undefined;
      let sendUrl: string | undefined;
      let wakeSlug = "dm";
      let wakeAlias = "";
      let mapRow: ChannelMapRow | undefined;

      if (message.guild) {
        const authz = authorizeGuildMessage(cfg, message);
        if (!authz.ok) {
          if (authz.reason && authz.reason !== "mention_required") {
            console.log(
              `[deny] guild msg=${message.id} reason=${authz.reason} user=${message.author.id} ch=${message.channelId}`,
            );
          }
          return;
        }
        agentId = authz.agentId;
        sendUrl = authz.sendPromptUrl;
        mapRow = authz.mapRow;
        wakeSlug = authz.mapRow?.slug || authz.mapRow?.channelId || "unknown";
        wakeAlias = authz.mapRow?.alias || authz.agentId || "";
      } else {
        const authz = authorizeDm(cfg, message.author);
        if (!authz.ok) {
          console.log(
            `[deny] dm user=${message.author.id} reason=${authz.reason}`,
          );
          if (authz.reason === "dm_not_paired") {
            await message.reply(
              "Not paired. Ask the owner to run `!pair <yourId>` (deny-by-default).",
            ).catch(() => undefined);
          }
          return;
        }
        agentId = authz.agentId;
        sendUrl = authz.sendPromptUrl;
        wakeSlug = cfg.security.dm?.slug || "dm";
        wakeAlias = cfg.security.dm?.alias || authz.agentId || "";
      }

      if (!agentId || !sendUrl) {
        console.log(`[deny] missing agent/url msg=${message.id}`);
        return;
      }

      const hop = hopId(wakeSlug, message.id);
      logTiming({
        msg: message.id,
        hop,
        stage: "authz",
        ms: elapsedMs(t0),
        ok: true,
      });

      const tWake = monoMs();
      const cleaned = stripBotMention(
        message.content,
        message.client.user?.id ?? null,
      );
      const attachmentRefs = wakeAttachmentRefsFromDiscord(message);
      // Text-only wakes unchanged; attachment-only messages also wake.
      if (!cleaned && attachmentRefs.length === 0) return;

      const prompt = buildPrompt(message, cleaned, {
        slug: wakeSlug,
        alias: wakeAlias,
        attachments: attachmentRefs,
      });
      const metadata: Record<string, unknown> = {
        source: "discord-bridge",
        discordMessageId: message.id,
        discordChannelId: message.channelId,
        discordUserId: message.author.id,
        discordGuildId: message.guild?.id ?? null,
        callbackBaseUrl: cfg.callbackBaseUrl,
        callbackPath: cfg.callbackPath,
      };
      if (attachmentRefs.length > 0) {
        metadata.attachments = attachmentRefs;
      }
      logTiming({
        msg: message.id,
        hop,
        stage: "build_wake",
        ms: elapsedMs(tWake),
        attachments: attachmentRefs.length,
      });

      if (isLocalPlannerRow(mapRow)) {
        const tLocal = monoMs();
        try {
          const local = await invokeLocalPlanner(cfg, {
            userPrompt: cleaned || "(attachment)",
            imagePath: attachmentRefs[0]?.url ?? "",
            channelId: message.channelId,
            slug: wakeSlug,
            messageId: message.id,
            callbackUrl: joinCallbackUrl(cfg.callbackBaseUrl, cfg.callbackPath),
            dryRun: false,
          });
          logTiming({
            msg: message.id,
            hop,
            stage: "localPlanner",
            ms: elapsedMs(tLocal),
            ok: local.ok,
            exit: local.exitCode ?? "",
          });
          if (!local.ok) {
            console.warn(
              `[local-planner] not ok msg=${message.id} status=${local.status} exit=${local.exitCode ?? ""}`,
            );
            await message.react("⚠️").catch(() => undefined);
            return;
          }
          await message.react("✅").catch(() => undefined);
        } catch (localErr) {
          logTiming({
            msg: message.id,
            hop,
            stage: "localPlanner",
            ms: elapsedMs(tLocal),
            ok: false,
          });
          throw localErr;
        }
        return;
      }

      const tSend = monoMs();
      let accepted = false;
      try {
        const result = await sendPrompt(
          sendUrl,
          {
            agentId,
            prompt,
            metadata,
          },
          cfg.gatewayToken,
        );
        accepted = Boolean(result.accepted);
        logTiming({
          msg: message.id,
          hop,
          stage: "sendPrompt",
          ms: elapsedMs(tSend),
          ok: accepted,
        });
        if (!accepted) {
          console.warn(`[sendPrompt] not accepted:`, result);
          await message.react("⚠️").catch(() => undefined);
          return;
        }
        markSendPromptAccepted(message.id);
        await message.react("✅").catch(() => undefined);
      } catch (sendErr) {
        logTiming({
          msg: message.id,
          hop,
          stage: "sendPrompt",
          ms: elapsedMs(tSend),
          ok: false,
        });
        throw sendErr;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discord] handler error:`, msg);
      await message.react("❌").catch(() => undefined);
    }
  });
}

export async function loginDiscord(
  client: Client,
  token: string,
): Promise<void> {
  await client.login(token);
}
