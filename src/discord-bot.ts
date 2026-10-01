import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
} from "discord.js";
import type { AppConfig } from "./config.js";
import { sendPrompt } from "./grok-client.js";
import {
  authorizeDm,
  authorizeGuildMessage,
  isGuildOwner,
  pairUser,
  stripBotMention,
} from "./security.js";

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

/** Pure wake prompt: `d:<slug>:<message.id>`, thin JSON `{id,g,u,map}`, human text. */
export function formatWakePrompt(args: {
  slug: string;
  messageId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  userTag: string;
  alias: string;
  cleaned: string;
}): string {
  const plugId = `d:${args.slug}:${args.messageId}`;
  const thin = JSON.stringify({
    id: plugId,
    g: args.guildId,
    u: args.userId,
    map: args.alias,
  });
  return [plugId, thin, args.cleaned].join("\n");
}

function buildPrompt(
  message: Message,
  cleaned: string,
  opts: { slug: string; alias: string },
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
  });
}

export function wireDiscord(client: Client, cfg: AppConfig): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] ready as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
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

      const cleaned = stripBotMention(
        message.content,
        message.client.user?.id ?? null,
      );
      if (!cleaned) return;

      const prompt = buildPrompt(message, cleaned, {
        slug: wakeSlug,
        alias: wakeAlias,
      });
      const result = await sendPrompt(
        sendUrl,
        {
          agentId,
          prompt,
          metadata: {
            source: "discord-bridge",
            discordMessageId: message.id,
            discordChannelId: message.channelId,
            discordUserId: message.author.id,
            discordGuildId: message.guild?.id ?? null,
            callbackBaseUrl: cfg.callbackBaseUrl,
            callbackPath: cfg.callbackPath,
          },
        },
        cfg.gatewayToken || undefined,
      );

      if (!result.accepted) {
        console.warn(`[sendPrompt] not accepted:`, result);
        await message.react("⚠️").catch(() => undefined);
        return;
      }
      await message.react("✅").catch(() => undefined);
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
