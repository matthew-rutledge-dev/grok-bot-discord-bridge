import { readFileSync } from "node:fs";
import { ChannelMapFile, SecurityFile } from "./types.js";

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
  };
}
