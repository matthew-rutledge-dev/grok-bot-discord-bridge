export interface ChannelMapRow {
  enabled: boolean;
  channelId: string;
  /** Stable short name for wake header `d:<slug>:<messageId>` (e.g. ai-gen-chat). */
  slug: string;
  /** Agent alias for optional thin JSON `map` field (e.g. Rimuru_orch). */
  alias?: string;
  label?: string;
  agentId: string;
  sendPromptUrl?: string | null;
  requireMention?: boolean;
}

export interface ChannelMapFile {
  version: number;
  description?: string;
  defaultSendPromptUrl?: string | null;
  channels: ChannelMapRow[];
}

export interface GuildSecurity {
  enabled: boolean;
  label?: string;
  requireMention: boolean;
  ownerId?: string;
  allowFrom: string[];
  allowRoles: string[];
  allowChannels: string[];
}

export interface DmSecurity {
  policy: "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  ownerId?: string;
  defaultAgentId?: string | null;
  /** Optional DM wake slug (default: dm). */
  slug?: string;
  /** Optional DM agent alias for thin JSON map. */
  alias?: string;
}

export interface SecurityFile {
  version: number;
  description?: string;
  guilds: Record<string, GuildSecurity>;
  dm: DmSecurity;
  ignoreBots: boolean;
}

export interface SendPromptRequest {
  agentId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface SendPromptResponse {
  accepted: boolean;
  [key: string]: unknown;
}

export interface CallbackPayload {
  channelId?: string;
  userId?: string;
  content: string;
  replyToMessageId?: string;
  agentId?: string;
}
