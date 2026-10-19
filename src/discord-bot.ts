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
  HOLD_GAVE_UP_TEXT,
  HOLD_STATUS_TEXT,
  SendPromptHoldQueue,
  type HeldHop,
  type HoldUi,
} from "./sendprompt-hold.js";
import {
  PLANNER_START_FAILED_TEXT,
  cancelGrokBuildHold,
  workingProgressText,
  forgetPlannerStatus,
  registerGrokBuildHold,
  invokeLocalPlanner,
  isGrokBuildRow,
  isLocalPlannerRow,
  joinCallbackUrl,
  plannerImageFields,
  plannerUserSignal,
  rememberPlannerStatus,
} from "./local-planner.js";
import type { ChannelMapRow } from "./types.js";
import { UserDirectory, type WakeIdentity } from "./user-directory.js";
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
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
  });
}

/**
 * Pure wake prompt: `d:<slug>:<message.id>`, thin JSON
 * `{id,g,u,un?,dn?,lb?,c?,map,a?}`, human text.
 */
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
  /** Optional sender identity from the user directory (0.2.11). */
  who?: WakeIdentity;
}): string {
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

function buildPrompt(
  message: Message,
  cleaned: string,
  opts: {
    slug: string;
    alias: string;
    attachments?: WakeAttachmentRef[];
    who?: WakeIdentity;
  },
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
    who: opts.who,
  });
}

async function fetchMessageChannel(client: Client, channelId: string) {
  const ch = await client.channels.fetch(channelId);
  if (!ch || !ch.isTextBased() || !("messages" in ch)) {
    throw new Error(`channel ${channelId} not text`);
  }
  return ch;
}

/**
 * Discord side of the sendPrompt hold. Uses the live Message when it is still
 * in memory, otherwise fetches by id (after a restart reload).
 */
export function discordHoldUi(
  client: Client,
  live: Map<string, Message>,
): HoldUi {
  async function original(hop: HeldHop): Promise<Message> {
    const cached = live.get(hop.messageId);
    if (cached) return cached;
    const ch = await fetchMessageChannel(client, hop.channelId);
    return ch.messages.fetch(hop.messageId);
  }
  async function editStatus(hop: HeldHop, content: string): Promise<boolean> {
    if (!hop.statusMessageId) return false;
    const ch = await fetchMessageChannel(client, hop.channelId);
    await ch.messages.edit(hop.statusMessageId, { content });
    return true;
  }
  return {
    async holding(hop) {
      if (await editStatus(hop, HOLD_STATUS_TEXT).catch(() => false)) {
        return hop.statusMessageId;
      }
      const msg = await original(hop);
      const posted = await msg.reply(HOLD_STATUS_TEXT);
      return posted.id;
    },
    async delivered(hop, result, info) {
      const accepted = Boolean(result.accepted);
      logTiming({
        msg: hop.messageId,
        hop: hop.hop,
        stage: "sendPrompt",
        ms: info.elapsedMs,
        ok: accepted,
        held: info.held ? true : undefined,
        tries: hop.tries > 1 ? hop.tries : undefined,
      });
      try {
        if (hop.statusMessageId) {
          const ch = await fetchMessageChannel(client, hop.channelId);
          await ch.messages.delete(hop.statusMessageId).catch(() => undefined);
        }
        const msg = await original(hop);
        if (!accepted) {
          console.warn(`[sendPrompt] not accepted:`, result);
          await msg.react("⚠️").catch(() => undefined);
          return;
        }
        markSendPromptAccepted(hop.messageId);
        await msg.react("✅").catch(() => undefined);
      } finally {
        live.delete(hop.messageId);
      }
    },
    async failed(hop, _err, info) {
      logTiming({
        msg: hop.messageId,
        hop: hop.hop,
        stage: "sendPrompt",
        ms: info.elapsedMs,
        ok: false,
        held: info.held ? true : undefined,
        tries: hop.tries > 1 ? hop.tries : undefined,
      });
      try {
        if (info.held) {
          const edited = await editStatus(hop, HOLD_GAVE_UP_TEXT).catch(() => false);
          if (!edited) {
            const msg = await original(hop);
            await msg.reply(HOLD_GAVE_UP_TEXT).catch(() => undefined);
          }
        }
        const msg = await original(hop);
        await msg.react("❌").catch(() => undefined);
      } finally {
        live.delete(hop.messageId);
      }
    },
  };
}

export function wireDiscord(
  client: Client,
  cfg: AppConfig,
  users: UserDirectory = new UserDirectory({
    filePath: cfg.userDirectoryFile,
    seedPath: cfg.userDirectorySeedFile,
  }),
): void {
  users.load();
  const liveMessages = new Map<string, Message>();
  const holdQueue = new SendPromptHoldQueue({
    filePath: cfg.sendPromptHoldFile,
    maxMs: cfg.sendPromptHoldMaxSec * 1000,
    send: (hop) => sendPrompt(hop.sendUrl, hop.request, cfg.gatewayToken),
    ui: discordHoldUi(client, liveMessages),
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] ready as ${c.user.tag}`);
    void holdQueue.load().catch((err) => {
      console.warn(
        `[sendPrompt] hold reload failed err=${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  // Learn who interacts with the bot (no handler today; this only records the user).
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.user.bot) return;
    const member = interaction.member;
    users.learn({
      id: interaction.user.id,
      username: interaction.user.username,
      globalName: interaction.user.globalName,
      displayName:
        member && "displayName" in member ? (member.displayName as string) : undefined,
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    const t0 = monoMs();
    try {
      if (message.author.bot) return;
      // Every human author, before authz: names and times only, no content.
      users.learn({
        id: message.author.id,
        username: message.author.username,
        globalName: message.author.globalName,
        displayName: message.member?.displayName,
      });

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
        wakeAlias = authz.alias || cfg.security.dm?.alias || authz.agentId || "";
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

      const who = users.wakeIdentity(message.author.id);
      const prompt = buildPrompt(message, cleaned, {
        slug: wakeSlug,
        alias: wakeAlias,
        attachments: attachmentRefs,
        who,
      });
      const metadata: Record<string, unknown> = {
        source: "discord-bridge",
        discordMessageId: message.id,
        discordChannelId: message.channelId,
        discordUserId: message.author.id,
        ...(Object.keys(who).length > 0 ? { discordUser: who } : {}),
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
        // Progress is a channel message, not a spinner. The handler returns
        // without waiting for generation. A later callback edits this message.
        let working: Message | undefined;
        let pulse: ReturnType<typeof setInterval> | undefined;
        const startedAt = Date.now();
        try {
          working = await message.reply(workingProgressText(0));
          rememberPlannerStatus(message.id, {
            channelId: message.channelId,
            statusMessageId: working.id,
          });
          pulse = setInterval(() => {
            if (!working) return;
            void working.edit({ content: workingProgressText(Date.now() - startedAt) }).catch(() => undefined);
          }, 5_000);
          pulse.unref?.();
          registerGrokBuildHold(message.id, () => {
            if (pulse) clearInterval(pulse);
          });
        } catch (postErr) {
          const postMsg = postErr instanceof Error ? postErr.message : String(postErr);
          console.warn(
            `[local-planner] working message failed msg=${message.id} err=${postMsg}`,
          );
        }
        // Do not abort: the listener may hold this HTTP call until the planner
        // exits, and aborting it can stop that work. Do not raise the timeout.
        // Transport failure (dropped connection, fetch failed) is not a red X.
        void invokeLocalPlanner(cfg, {
          userPrompt: cleaned || "(attachment)",
          ...plannerImageFields(attachmentRefs),
          channelId: message.channelId,
          slug: wakeSlug,
          messageId: message.id,
          callbackUrl: joinCallbackUrl(cfg.callbackBaseUrl, cfg.callbackPath),
          statusMessageId: working?.id,
          dryRun: false,
        }).then(async (local) => {
          const signal = plannerUserSignal(local);
          logTiming({
            msg: message.id,
            hop,
            stage: "localPlanner",
            ms: elapsedMs(tLocal),
            ok: signal === "accepted",
            exit: local.exitCode ?? "",
          });
          if (signal === "accepted") {
            await message.react("✅").catch(() => undefined);
            return;
          }
          if (signal === "start_failed") {
            console.warn(
              `[local-planner] not started msg=${message.id} status=${local.status} detail=${local.detail ?? ""}`,
            );
            cancelGrokBuildHold(message.id);
            forgetPlannerStatus(message.id, working?.id);
            if (working) {
              await working.edit({ content: PLANNER_START_FAILED_TEXT }).catch(() => undefined);
            }
            return;
          }
          console.warn(
            `[local-planner] ${signal} msg=${message.id} status=${local.status} detail=${local.detail ?? ""} (not a final failure)`,
          );
        }).catch((localErr) => {
          logTiming({
            msg: message.id,
            hop,
            stage: "localPlanner",
            ms: elapsedMs(tLocal),
            ok: false,
          });
          const msgText = localErr instanceof Error ? localErr.message : String(localErr);
          console.warn(
            `[local-planner] transport msg=${message.id} err=${msgText} (not a final failure)`,
          );
        });
        return;
      }

      if (isGrokBuildRow(mapRow)) {
        const tGrok = monoMs();
        let posted: Message | undefined;
        let pulse: ReturnType<typeof setInterval> | undefined;
        const startedAt = Date.now();
        const typing = setInterval(() => {
          const channel = message.channel;
          if ("sendTyping" in channel) {
            void channel.sendTyping().catch(() => undefined);
          }
        }, 8_000);
        typing.unref?.();
        if ("sendTyping" in message.channel) {
          void message.channel.sendTyping().catch(() => undefined);
        }
        try {
          posted = await message.reply(workingProgressText(0));
          rememberPlannerStatus(message.id, {
            channelId: message.channelId,
            statusMessageId: posted.id,
          });
          pulse = setInterval(() => {
            if (!posted) return;
            void posted.edit({ content: workingProgressText(Date.now() - startedAt) }).catch(() => undefined);
          }, 5_000);
          pulse.unref?.();
        } catch (postErr) {
          const postMsg = postErr instanceof Error ? postErr.message : String(postErr);
          console.warn(
            `[grok-build] working message failed msg=${message.id} err=${postMsg}`,
          );
        }
        registerGrokBuildHold(message.id, () => {
          clearInterval(typing);
          if (pulse) clearInterval(pulse);
        });
        const grokUrl = cfg.localPlannerUrl.trim().replace(/\/plan\/?$/, "/chat");
        void invokeLocalPlanner(
          { ...cfg, localPlannerUrl: grokUrl },
          {
            userPrompt: cleaned || "(attachment)",
            imagePath: "",
            channelId: message.channelId,
            slug: wakeSlug,
            messageId: message.id,
            callbackUrl: joinCallbackUrl(cfg.callbackBaseUrl, cfg.callbackPath),
            dryRun: false,
            profile: mapRow?.profile,
            attachments: attachmentRefs,
          },
        ).then(async (local) => {
          const signal = plannerUserSignal(local);
          logTiming({
            msg: message.id,
            hop,
            stage: "grokBuild",
            ms: elapsedMs(tGrok),
            ok: signal === "accepted",
            exit: local.exitCode ?? "",
          });
          if (signal === "accepted") {
            await message.react("✅").catch(() => undefined);
            return;
          }
          if (signal === "start_failed") {
            console.warn(
              `[grok-build] not started msg=${message.id} status=${local.status} detail=${local.detail ?? ""}`,
            );
            cancelGrokBuildHold(message.id);
            forgetPlannerStatus(message.id, posted?.id);
            if (posted) {
              await posted.edit({ content: PLANNER_START_FAILED_TEXT }).catch(() => undefined);
            } else {
              await message.reply(PLANNER_START_FAILED_TEXT).catch(() => undefined);
            }
            return;
          }
          console.warn(
            `[grok-build] ${signal} msg=${message.id} status=${local.status} detail=${local.detail ?? ""} (not a final failure)`,
          );
        }).catch((localErr) => {
          logTiming({
            msg: message.id,
            hop,
            stage: "grokBuild",
            ms: elapsedMs(tGrok),
            ok: false,
          });
          const msgText = localErr instanceof Error ? localErr.message : String(localErr);
          console.warn(
            `[grok-build] transport msg=${message.id} err=${msgText} (not a final failure)`,
          );
        });
        return;
      }

      // sendPrompt goes through the hold queue: one immediate try, then hold
      // and retry on tunnel outages (530/1033/502-504/network). Later hops
      // from the same channel wait behind a held one. Reactions and timing
      // come from discordHoldUi.
      liveMessages.set(message.id, message);
      await holdQueue.submit({
        messageId: message.id,
        channelId: message.channelId,
        hop,
        sendUrl,
        request: { agentId, prompt, metadata },
      });
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
