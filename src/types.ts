export interface ChannelMapRow {
  enabled: boolean;
  channelId: string;
  /** Stable short name for wake header `d:<slug>:<messageId>` (e.g. ai-gen-chat). */
  slug: string;
  /** Agent alias for optional thin JSON `map` field (e.g. chat-agent). */
  alias?: string;
  label?: string;
  agentId: string;
  sendPromptUrl?: string | null;
  requireMention?: boolean;
  /**
   * Opt-in only. Unset (fresh install) keeps sendPrompt.
   * Local planner hop requires all three: primary_llm "local",
   * wake_agent false, local_handler "rumble-pixel-planner".
   */
  primary_llm?: string;
  wake_agent?: boolean;
  local_handler?: string;
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

/** Base64 body (no data-URL prefix). Requires filename. */
export interface CallbackAttachmentData {
  filename: string;
  contentType?: string;
  data: string;
}

/** HTTPS URL fetched by the bridge (~15s timeout, size/mime caps). */
export interface CallbackAttachmentUrl {
  filename?: string;
  contentType?: string;
  url: string;
}

export type CallbackAttachment = CallbackAttachmentData | CallbackAttachmentUrl;

/**
 * POST /callback JSON body.
 * `content` optional when attachments length ≥ 1.
 * Auth: Authorization Bearer or x-callback-token header only (?token= removed in 0.2.4).
 */
export interface CallbackPayload {
  channelId?: string;
  userId?: string;
  content?: string;
  replyToMessageId?: string;
  /**
   * Edit this message instead of sending a new one.
   * Local-planner hops set this to the "Working on it." message id.
   */
  statusMessageId?: string;
  /** Posted into a thread on the delivered message, not on the message itself. */
  threadContent?: string;
  agentId?: string;
  /** Max 10; each ≤8 MiB; total ≤25 MiB. */
  attachments?: CallbackAttachment[];
}

/** Thin-wake attachment URL refs (inbound MessageCreate → sendPrompt). */
export interface WakeAttachmentRef {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
}
