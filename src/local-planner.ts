import type { ChannelMapRow } from "./types.js";

export interface LocalPlannerRequest {
  userPrompt: string;
  imagePath: string;
  channelId: string;
  slug: string;
  /** Inbound Discord message id. Never a placeholder. */
  messageId: string;
  /**
   * Bridge POST /callback URL (CALLBACK_BASE_URL + CALLBACK_PATH).
   * No token. Auth stays on the callback request headers.
   */
  callbackUrl: string;
  dryRun: boolean;
}

export interface LocalPlannerResult {
  ok: boolean;
  status: number;
  exitCode?: number;
  detail?: string;
}

/**
 * Opt-in. Missing fields, or any value other than the trio below, means sendPrompt.
 * Does not invent an agent id; caller still has the row's real agentId and must not use it
 * when this returns true.
 */
export function isLocalPlannerRow(
  row: ChannelMapRow | null | undefined,
): boolean {
  if (!row?.enabled) return false;
  return (
    row.primary_llm === "local" &&
    row.wake_agent === false &&
    row.local_handler === "rumble-pixel-planner"
  );
}


/**
 * Public callback endpoint the local handler should POST to.
 * Joins CALLBACK_BASE_URL and CALLBACK_PATH. Does not append a token.
 */
export function joinCallbackUrl(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, "");
  const raw = path.trim() || "/callback";
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return `${b}${p}`;
}

/**
 * Planner HTTP call. Puts the real Discord message id and callback URL on the
 * query string (replacing any placeholder messageId) and never puts a token there.
 */
export function withPlannerCallbackQuery(
  plannerUrl: string,
  messageId: string,
  callbackUrl: string,
): string {
  const u = new URL(plannerUrl);
  u.searchParams.set("messageId", messageId);
  u.searchParams.set("callbackUrl", callbackUrl);
  u.searchParams.delete("token");
  return u.toString();
}

export async function invokeLocalPlanner(
  cfg: { localPlannerUrl: string; localPlannerToken: string },
  body: LocalPlannerRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 180_000,
): Promise<LocalPlannerResult> {
  const url = cfg.localPlannerUrl.trim();
  const token = cfg.localPlannerToken.trim();
  if (!url || !token) {
    return { ok: false, status: 0, detail: "local_planner_not_configured" };
  }
  let requestUrl: string;
  try {
    requestUrl = withPlannerCallbackQuery(url, body.messageId, body.callbackUrl);
  } catch {
    return { ok: false, status: 0, detail: "local_planner_bad_url" };
  }
  const res = await fetchImpl(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let exitCode: number | undefined;
  let detail: string | undefined;
  try {
    const parsed = (await res.json()) as {
      ok?: boolean;
      exitCode?: number;
      error?: string;
    };
    if (typeof parsed.exitCode === "number") exitCode = parsed.exitCode;
    if (typeof parsed.error === "string") detail = parsed.error.slice(0, 120);
    return {
      ok: res.ok && parsed.ok === true,
      status: res.status,
      exitCode,
      detail,
    };
  } catch {
    return { ok: false, status: res.status, detail: "local_planner_bad_response" };
  }
}
