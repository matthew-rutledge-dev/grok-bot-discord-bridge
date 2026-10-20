import { readFileSync } from "node:fs";
import { ChannelMapFile, SecurityFile } from "./types.js";
import { parseWakePromptFormat, type WakePromptFormat } from "./wake-prompt.js";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function csv(name: string): string[] {
  const raw = env(name);
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPlaceholderToken(token: string): boolean {
  if (!token) return true;
  const lower = token.toLowerCase();
  if (lower === "changeme" || lower === "change-me" || lower === "placeholder") {
    return true;
  }
  // Discord bot tokens are typically three base64-ish segments
  if (token.split(".").length < 3) return true;
  return false;
}

export interface AppConfig {
  discordToken: string;
  hasRealDiscordToken: boolean;
  guildId: string;
  allowFrom: string[];
  allowRoles: string[];
  allowChannels: string[];
  ownerId: string;
  dmPolicy: "pairing" | "allowlist" | "disabled";
  sendPromptUrl: string;
  gatewayToken: string;
  callbackToken: string;
  /** Soft POST /callback limit per minute (0 = disabled). Default 90. */
  callbackRateLimitPerMin: number;
  callbackPath: string;
  callbackBaseUrl: string;
  httpBind: string;
  httpPort: number;
  channelMapPath: string;
  securityPath: string;
  requireMentionDefault: boolean;
  httpOnly: boolean;
  channelMap: ChannelMapFile;
  security: SecurityFile;
  /** Optional. Blank keeps every row on sendPrompt unless a row opts in and then fails closed. */
  localPlannerUrl: string;
  localPlannerToken: string;
  /** sendPrompt hold window in seconds (default 900). 0 = no hold. */
  sendPromptHoldMaxSec: number;
  /** JSON backup for held sendPrompt hops. Empty = memory only. */
  sendPromptHoldFile: string;
  /** Optional wake hook URL (0.2.12). Blank = off. */
  sendPromptWakeUrl: string;
  /** Optional wake hook key. Never logged. */
  sendPromptWakeKey: string;
  /** Header for the wake key. `Authorization` = `Bearer <key>`; any other name = raw key. */
  sendPromptWakeHeader: string;
  /** User directory JSON (0.2.11). Empty = memory only. */
  userDirectoryFile: string;
  /** Optional read-only seed for the user directory. Missing file = no seed. */
  userDirectorySeedFile: string;
  /** Wake prompt shape (0.2.14). `compact` (default) or `legacy` (0.2.13 thin JSON). */
  wakePromptFormat: WakePromptFormat;
}

export function loadConfig(): AppConfig {
  const discordToken = env("DISCORD_BOT_TOKEN");
  const hasRealDiscordToken = !isPlaceholderToken(discordToken);
  const channelMapPath = env("CHANNEL_MAP_PATH", "./config/channel-map.json");
  const securityPath = env("SECURITY_CONFIG_PATH", "./config/security.json");

  const channelMap = JSON.parse(
    readFileSync(channelMapPath, "utf8"),
  ) as ChannelMapFile;
  const security = JSON.parse(readFileSync(securityPath, "utf8")) as SecurityFile;

  const dmPolicyRaw = env("DISCORD_DM_POLICY", security.dm?.policy ?? "pairing");
  const dmPolicy =
    dmPolicyRaw === "allowlist" || dmPolicyRaw === "disabled"
      ? dmPolicyRaw
      : "pairing";

  return {
    discordToken,
    hasRealDiscordToken,
    guildId: env("DISCORD_GUILD_ID"),
    allowFrom: csv("DISCORD_ALLOWFROM"),
    allowRoles: csv("DISCORD_ALLOW_ROLES"),
    allowChannels: csv("DISCORD_ALLOW_CHANNELS"),
    ownerId: env("DISCORD_OWNER_ID"),
    dmPolicy,
    sendPromptUrl: env(
      "GROK_BOT_SENDPROMPT_URL",
      "http://127.0.0.1:1340/api/sendPrompt",
    ),
    gatewayToken: env("GROK_BOT_GATEWAY_TOKEN"),
    callbackToken: env("CALLBACK_TOKEN"),
    callbackRateLimitPerMin: (() => {
      const raw = env("CALLBACK_RATE_LIMIT_PER_MIN", "90");
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return 90;
      return Math.floor(n);
    })(),
    callbackPath: env("CALLBACK_PATH", "/callback"),
    callbackBaseUrl: env("CALLBACK_BASE_URL", "http://127.0.0.1:18083"),
    httpBind: env("HTTP_BIND", "127.0.0.1"),
    httpPort: Number(env("HTTP_PORT", "18083")) || 18083,
    channelMapPath,
    securityPath,
    requireMentionDefault: env("REQUIRE_MENTION_DEFAULT", "true") !== "false",
    httpOnly: env("HTTP_ONLY", "0") === "1",
    channelMap,
    security,
    localPlannerUrl: env("LOCAL_PLANNER_URL"),
    localPlannerToken: env("LOCAL_PLANNER_TOKEN"),
    sendPromptHoldMaxSec: (() => {
      const n = Number(env("SENDPROMPT_HOLD_MAX_SEC", "900"));
      if (!Number.isFinite(n) || n < 0) return 900;
      return Math.floor(n);
    })(),
    sendPromptHoldFile:
      process.env.SENDPROMPT_HOLD_FILE === undefined
        ? "./data/sendprompt-hold.json"
        : env("SENDPROMPT_HOLD_FILE"),
    sendPromptWakeUrl: env("SENDPROMPT_WAKE_URL"),
    sendPromptWakeKey: env("SENDPROMPT_WAKE_KEY"),
    sendPromptWakeHeader: env("SENDPROMPT_WAKE_HEADER", "Authorization"),
    userDirectoryFile:
      process.env.USER_DIRECTORY_FILE === undefined
        ? "./data/user-directory.json"
        : env("USER_DIRECTORY_FILE"),
    userDirectorySeedFile:
      process.env.USER_DIRECTORY_SEED_FILE === undefined
        ? "./config/user-directory.seed.json"
        : env("USER_DIRECTORY_SEED_FILE"),
    wakePromptFormat: (() => {
      const { format, valid } = parseWakePromptFormat(process.env.WAKE_PROMPT_FORMAT);
      if (!valid) {
        console.warn(`[config] WAKE_PROMPT_FORMAT not compact|legacy, using ${format}`);
      }
      return format;
    })(),
  };
}
