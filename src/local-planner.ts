import type { ChannelMapRow } from "./types.js";

export interface LocalPlannerRequest {
  userPrompt: string;
  /** Discord attachment[0] CDN URL (base image). Empty when text-only. */
  imagePath: string;
  /**
   * Discord attachment[1] CDN URL (optional reference). Empty when absent.
   * Pixel listener: referenceImagePath / reference_image_path / imagePaths[1].
   */
  referenceImagePath?: string;
  /**
   * Up to two attachment URLs: [base, optional reference]. Alternate listener path.
   */
  imagePaths?: string[];
  channelId: string;
  slug: string;
  /** Inbound Discord message id. Never a placeholder. */
  messageId: string;
  /**
   * Bridge POST /callback URL (CALLBACK_BASE_URL + CALLBACK_PATH).
   * No token. Auth stays on the callback request headers.
   */
  callbackUrl: string;
  /**
   * Discord message id of the bridge "Working on it." reply, when one was posted.
   * The handler should send this back on the existing callback as statusMessageId.
   */
  statusMessageId?: string;
  dryRun: boolean;
}

export interface LocalPlannerResult {
  ok: boolean;
  status: number;
  exitCode?: number;
  detail?: string;
}

/** Posted in-channel before the planner HTTP call. Not a reaction. */
export const PLANNER_WORKING_TEXT = "Working on it.";

/** Edited onto the working message when the hop never starts. Not used for timeouts. */
export const PLANNER_START_FAILED_TEXT = "Couldn't start that.";

export type PlannerUserSignal =
  | "start_failed"
  | "transport"
  | "accepted"
  | "inconclusive";

/**
 * What the bridge may show the user for a planner HTTP result.
 * A dropped connection or timeout is transport: not a red X, not a final failure.
 * start_failed is only config or an HTTP reject before work (401/403/404).
 */
export function plannerUserSignal(result: LocalPlannerResult): PlannerUserSignal {
  if (
    result.detail === "local_planner_not_configured" ||
    result.detail === "local_planner_bad_url" ||
    result.status === 401 ||
    result.status === 403 ||
    result.status === 404
  ) {
    return "start_failed";
  }
  if (result.status === 0 || result.detail === "local_planner_transport") {
    return "transport";
  }
  if (result.ok) return "accepted";
  return "inconclusive";
}

export interface PlannerStatusRef {
  channelId: string;
  statusMessageId: string;
}

const PLANNER_STATUS_MAX = 200;
const plannerStatusByOrigin = new Map<string, PlannerStatusRef>();

/** Remember the working message for an inbound Discord message id. */
export function rememberPlannerStatus(
  originMessageId: string,
  status: PlannerStatusRef,
): void {
  const id = originMessageId.trim();
  if (!id || !status.statusMessageId.trim()) return;
  plannerStatusByOrigin.delete(id);
  plannerStatusByOrigin.set(id, {
    channelId: status.channelId,
    statusMessageId: status.statusMessageId.trim(),
  });
  while (plannerStatusByOrigin.size > PLANNER_STATUS_MAX) {
    const oldest = plannerStatusByOrigin.keys().next().value;
    if (oldest === undefined) break;
    plannerStatusByOrigin.delete(oldest);
  }
}

export function lookupPlannerStatus(
  originMessageId: string | undefined,
): PlannerStatusRef | undefined {
  if (!originMessageId) return undefined;
  return plannerStatusByOrigin.get(originMessageId.trim());
}

/** Drop a remembered working message by origin id and/or the status message id. */
export function forgetPlannerStatus(
  originMessageId?: string,
  statusMessageId?: string,
): void {
  if (originMessageId) plannerStatusByOrigin.delete(originMessageId.trim());
  if (!statusMessageId) return;
  const want = statusMessageId.trim();
  for (const [key, value] of plannerStatusByOrigin) {
    if (value.statusMessageId === want) plannerStatusByOrigin.delete(key);
  }
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
 * Map Discord wake attachment refs to Pixel local-planner body fields.
 * a[0] = base (imagePath), a[1] = optional reference (referenceImagePath).
 * a[2+] ignored. Matches rumble STATUS / Start-DiscordPlannerListener.ps1.
 */
export function plannerImageFields(
  attachmentRefs: ReadonlyArray<{ url: string }>,
): Pick<LocalPlannerRequest, "imagePath" | "referenceImagePath" | "imagePaths"> {
  const urls = attachmentRefs
    .map((r) => (typeof r.url === "string" ? r.url.trim() : ""))
    .filter(Boolean)
    .slice(0, 2);
  const imagePath = urls[0] ?? "";
  const referenceImagePath = urls[1] ?? "";
  return {
    imagePath,
    ...(referenceImagePath ? { referenceImagePath } : {}),
    ...(urls.length > 0 ? { imagePaths: urls } : {}),
  };
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
 * statusMessageId is set only when the bridge posted a working message.
 */
export function withPlannerCallbackQuery(
  plannerUrl: string,
  messageId: string,
  callbackUrl: string,
  statusMessageId?: string,
): string {
  const u = new URL(plannerUrl);
  u.searchParams.set("messageId", messageId);
  u.searchParams.set("callbackUrl", callbackUrl);
  const status = statusMessageId?.trim();
  if (status) u.searchParams.set("statusMessageId", status);
  else u.searchParams.delete("statusMessageId");
  u.searchParams.delete("token");
  return u.toString();
}

export async function invokeLocalPlanner(
  cfg: { localPlannerUrl: string; localPlannerToken: string },
  body: LocalPlannerRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 180_000,
  opts?: { abort?: boolean },
): Promise<LocalPlannerResult> {
  const url = cfg.localPlannerUrl.trim();
  const token = cfg.localPlannerToken.trim();
  if (!url || !token) {
    return { ok: false, status: 0, detail: "local_planner_not_configured" };
  }
  let requestUrl: string;
  try {
    requestUrl = withPlannerCallbackQuery(
      url,
      body.messageId,
      body.callbackUrl,
      body.statusMessageId,
    );
  } catch {
    return { ok: false, status: 0, detail: "local_planner_bad_url" };
  }
  // Default is no abort. AbortSignal.timeout used to cut the planner HTTP call
  // (previously 180s). A handler that holds that connection until the planner
  // exits can die with the abort. Timeouts are not raised; the bridge does not
  // wait on this call for the user-facing result.
  const abort = opts?.abort === true;
  try {
    const res = await fetchImpl(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      ...(abort ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
  } catch {
    return { ok: false, status: 0, detail: "local_planner_transport" };
  }
}
