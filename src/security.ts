import type { Guild, GuildMember, Message, User } from "discord.js";
import type { AppConfig } from "./config.js";
import type { ChannelMapRow, GuildSecurity } from "./types.js";

export type DenyReason =
  | "bot_author"
  | "guild_not_allowlisted"
  | "guild_disabled"
  | "user_not_allowlisted"
  | "role_not_allowlisted"
  | "channel_not_allowlisted"
  | "channel_map_disabled"
  | "channel_map_missing_agent"
  | "mention_required"
  | "dm_disabled"
  | "dm_not_paired"
  | "dm_no_agent";

export interface AuthzResult {
  ok: boolean;
  reason?: DenyReason;
  mapRow?: ChannelMapRow;
  agentId?: string;
  /** Direct-message alias when this person has their own agent. */
  alias?: string;
  sendPromptUrl?: string;
  requireMention?: boolean;
}

function guildPolicy(cfg: AppConfig, guildId: string | null): GuildSecurity | null {
  if (!guildId) return null;
  return cfg.security.guilds[guildId] ?? null;
}

function userAllowed(
  userId: string,
  policyAllow: string[],
  envAllow: string[],
): boolean {
  const set = new Set([...policyAllow, ...envAllow]);
  if (set.size === 0) return false; // deny-by-default
  return set.has(userId);
}

function roleAllowed(
  member: GuildMember | null,
  policyRoles: string[],
  envRoles: string[],
): boolean {
  const roles = [...policyRoles, ...envRoles];
  if (roles.length === 0) return true; // roles optional; users still gate
  if (!member) return false;
  return roles.some((r) => member.roles.cache.has(r));
}

function channelAllowed(
  channelId: string,
  policyChannels: string[],
  envChannels: string[],
): boolean {
  const channels = [...policyChannels, ...envChannels];
  if (channels.length === 0) return true; // empty → rely on channel-map
  return channels.includes(channelId);
}

function findMapRow(cfg: AppConfig, channelId: string): ChannelMapRow | undefined {
  return cfg.channelMap.channels.find((c) => c.channelId === channelId);
}

export function authorizeGuildMessage(
  cfg: AppConfig,
  message: Message,
): AuthzResult {
  const author = message.author;
  if (cfg.security.ignoreBots !== false && author.bot) {
    return { ok: false, reason: "bot_author" };
  }

  const guild = message.guild;
  if (!guild) {
    return { ok: false, reason: "guild_not_allowlisted" };
  }

  const policy = guildPolicy(cfg, guild.id);
  if (!policy) {
    return { ok: false, reason: "guild_not_allowlisted" };
  }
  if (!policy.enabled) {
    return { ok: false, reason: "guild_disabled" };
  }

  // Optional env guild pin
  if (cfg.guildId && cfg.guildId !== guild.id) {
    return { ok: false, reason: "guild_not_allowlisted" };
  }

  if (!userAllowed(author.id, policy.allowFrom, cfg.allowFrom)) {
    return { ok: false, reason: "user_not_allowlisted" };
  }

  const member = message.member;
  if (!roleAllowed(member, policy.allowRoles, cfg.allowRoles)) {
    return { ok: false, reason: "role_not_allowlisted" };
  }

  const channelId = message.channelId;
  if (!channelAllowed(channelId, policy.allowChannels, cfg.allowChannels)) {
    return { ok: false, reason: "channel_not_allowlisted" };
  }

  const mapRow = findMapRow(cfg, channelId);
  if (!mapRow || !mapRow.enabled) {
    return { ok: false, reason: "channel_map_disabled" };
  }
  if (!mapRow.agentId) {
    return { ok: false, reason: "channel_map_missing_agent" };
  }

  const requireMention =
    mapRow.requireMention ?? policy.requireMention ?? cfg.requireMentionDefault;

  if (requireMention) {
    const me = message.client.user;
    const mentioned =
      (me && message.mentions.users.has(me.id)) ||
      Boolean(me && message.content.includes(`<@${me.id}>`));
    if (!mentioned) {
      return { ok: false, reason: "mention_required" };
    }
  }

  const sendPromptUrl =
    mapRow.sendPromptUrl ||
    cfg.channelMap.defaultSendPromptUrl ||
    cfg.sendPromptUrl;

  return {
    ok: true,
    mapRow,
    agentId: mapRow.agentId,
    sendPromptUrl: sendPromptUrl || undefined,
    requireMention,
  };
}

/** In-memory DM pairing approvals (process lifetime). Owner can approve via !pair <userId>. */
const pairedUsers = new Set<string>();

export function pairUser(userId: string): void {
  pairedUsers.add(userId);
}

export function isPaired(userId: string): boolean {
  return pairedUsers.has(userId);
}

export function authorizeDm(
  cfg: AppConfig,
  author: User,
): AuthzResult {
  if (cfg.security.ignoreBots !== false && author.bot) {
    return { ok: false, reason: "bot_author" };
  }

  const dm = cfg.security.dm;
  const policy = cfg.dmPolicy || dm.policy || "pairing";
  if (policy === "disabled") {
    return { ok: false, reason: "dm_disabled" };
  }

  const allow = [...(dm.allowFrom ?? []), ...cfg.allowFrom];
  if (policy === "allowlist") {
    if (!userAllowed(author.id, allow, [])) {
      return { ok: false, reason: "user_not_allowlisted" };
    }
  } else {
    // pairing: allowlisted users auto-ok; others need pair
    if (!userAllowed(author.id, allow, []) && !pairedUsers.has(author.id)) {
      return { ok: false, reason: "dm_not_paired" };
    }
  }

  const assigned = resolveDmAssignment(dm.agentsByUser?.[author.id]);
  const agentId = assigned?.agentId || dm.defaultAgentId || undefined;
  if (!agentId) {
    return { ok: false, reason: "dm_no_agent" };
  }

  return {
    ok: true,
    agentId,
    alias: assigned?.alias,
    sendPromptUrl: cfg.sendPromptUrl,
  };
}

function resolveDmAssignment(
  raw: string | { agentId?: string | null; alias?: string } | undefined,
): { agentId: string; alias?: string } | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") {
    const agentId = raw.trim();
    return agentId ? { agentId } : undefined;
  }
  const agentId = (raw.agentId ?? "").trim();
  if (!agentId) return undefined;
  const alias = raw.alias?.trim();
  return alias ? { agentId, alias } : { agentId };
}

/** True when this user may receive an outbound bridge DM. */
export function dmRecipientAllowed(cfg: AppConfig, userId: string): boolean {
  const dm = cfg.security.dm;
  const policy = cfg.dmPolicy || dm.policy || "pairing";
  if (policy === "disabled") return false;
  const allow = [...(dm.allowFrom ?? []), ...cfg.allowFrom];
  if (userAllowed(userId, allow, [])) return true;
  if (pairedUsers.has(userId)) return true;
  const owner = dm.ownerId || cfg.ownerId;
  return Boolean(owner && owner === userId);
}

/** True when userId is on that connected host's admin list. */
export function isHostAdmin(
  cfg: AppConfig,
  host: string,
  userId: string,
): boolean {
  const list = cfg.security.hostAdmins?.[host] ?? [];
  return list.includes(userId);
}

export function stripBotMention(content: string, botUserId: string | null): string {
  if (!botUserId) return content.trim();
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .trim();
}

export function isGuildOwner(cfg: AppConfig, guild: Guild | null, userId: string): boolean {
  if (!guild) return false;
  const policy = guildPolicy(cfg, guild.id);
  const owner = policy?.ownerId || cfg.ownerId;
  return Boolean(owner && owner === userId);
}
