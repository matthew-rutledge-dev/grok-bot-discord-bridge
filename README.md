# grok-bot-discord-bridge

Thin **Discord Gateway → Grok Bot `sendPrompt` → Discord callback** bridge.

Self-hosted wake path for Discord → your Grok Bot agents. Configure **your own** Discord bot, guild allowlists, and deploy path. This repo ships example configs with placeholders only — never commit real tokens or live snowflakes.

## Architecture

```
Discord Gateway
    │  MessageCreate (deny-by-default authz)
    │  optional attachment URL refs in thin wake JSON `a`
    ▼
channel-map.json  →  agentId (+ optional per-row sendPrompt URL)
    │
    ▼
POST http://<computer>:1340/api/sendPrompt
    body: { "agentId": "...", "prompt": "..." }
    expect: { "accepted": true }
    │
    ▼
Grok Bot agent works…
    │
    ▼
POST http://127.0.0.1:18083/callback
    Authorization: Bearer <CALLBACK_TOKEN>
    JSON text and/or attachments, or multipart/form-data
    │
    ▼
Discord channel / DM message (text + files)
```

Local HTTP (loopback only via Compose publish):

| Path | Method | Purpose |
|------|--------|---------|
| `/healthz` | GET | Liveness + whether Discord is ready |
| `/callback` | POST | Agent → Discord delivery (token required; text and/or media) |

## Grok Build chat

A channel-map row can skip `sendPrompt` and call a local chat process. Set `enabled`, `primary_llm` to `local`, `wake_agent` to `false`, `harness` to `grok-build`, and a non-empty `profile`. Do not set `local_handler` to the image-planner handler. The bridge changes the local planner URL from `/plan` to `/chat` and posts the profile plus attachment refs.

Typing starts at once. After 15 seconds the bridge posts "Working on it." and edits that message with elapsed seconds. The callback replaces that message. If the callback arrives first, the hold is cancelled and the answer is a new reply. Image-planner rows still post "Working on it." immediately.

[grokbot-discord-fleet](https://github.com/matthew-rutledge-dev/grokbot-discord-fleet) is manage and status only. It does not receive channel messages, wake agents, or call `sendPrompt`. This repository is the wake path.

## Send one prompt

`scripts/send-grok-bot-prompt.mjs` posts `{ agentId, prompt }` to `GROK_BOT_SENDPROMPT_URL` with `GROK_BOT_GATEWAY_TOKEN`. Run it inside the bridge container, which already has those two values.

```bash
cp config/grok-bot-roster.example.json config/grok-bot-roster.json
node scripts/send-grok-bot-prompt.mjs example_bot "List the bots you know."
```

`config/grok-bot-roster.json` is gitignored. The example file has fake aliases only. Replace them with your own agent ids. The script refuses the placeholder ids.

## Security model (deny-by-default)

Evaluation order for **guild** messages:

1. **Ignore bots** (authors with `bot=true`)
2. **Guild allowlist** — must appear in `config/security.json` → `guilds` (and optional `DISCORD_GUILD_ID` pin)
3. **Users** — `DISCORD_ALLOWFROM` ∪ guild `allowFrom` (empty set = deny everyone)
4. **Roles** — if any roles configured (`DISCORD_ALLOW_ROLES` / guild `allowRoles`), member must hold one; if none configured, skip this gate
5. **Channels** — if any channel allowlist configured, channel must be listed; if empty, rely on channel-map
6. **Agent map** — `config/channel-map.json` row must be `enabled: true` with non-empty `agentId`
7. **Mention** — if `requireMention` (row → guild → `REQUIRE_MENTION_DEFAULT`), message must @ the bot

**DMs:** `DISCORD_DM_POLICY` / `security.dm.policy`:

- `pairing` — allowlisted users ok; others need owner `!pair <userId>`
- `allowlist` — only allowlisted users
- `disabled` — ignore DMs

Owner id seeds pairing approvals. No agent is invoked until an allow path succeeds.

### Example config (placeholders only)

Copy `config/security.json` and `config/channel-map.json`, then replace every placeholder snowflake and agent id with **your** values before go-live. Shipped examples use fake IDs so the repo stays installer-neutral.

| Field | Example placeholder |
|-------|--------|
| Guild | `111111111111111111` (`example-guild` label) |
| Users | `222222222222222222`, `333333333333333333` |
| Owner | `222222222222222222` |
| `requireMention` | set per guild in `security.json` (example uses `false`) |

## Env

See [`.env.example`](./.env.example). Notable names:

- `DISCORD_BOT_TOKEN` — required for Gateway login
- `DISCORD_GUILD_ID`, `DISCORD_ALLOWFROM`, `DISCORD_ALLOW_ROLES`, `DISCORD_ALLOW_CHANNELS`, `DISCORD_OWNER_ID`, `DISCORD_DM_POLICY`
- `GROK_BOT_SENDPROMPT_URL` — default `http://host.docker.internal:1340/api/sendPrompt` on Docker hosts that support it (or use LAN IP of the Grok Bot computer)
- `GROK_BOT_GATEWAY_TOKEN` — **required** Bearer for outbound sendPrompt (fail-closed: blank/unset refuses wakes; no unauthenticated POST)
- `CALLBACK_BASE_URL`, `CALLBACK_PATH`, `CALLBACK_TOKEN` (store the token in your host vault or secrets manager — never in git)
- `CALLBACK_RATE_LIMIT_PER_MIN` — soft callback limit (default `90`; `0` = off)
- `HTTP_BIND` / `HTTP_PORT` — container listens `0.0.0.0:18083`; Compose publishes `127.0.0.1:18083`

**Git never gets real secrets** — only `.env.example`. Host `.env` is local.

## Inbound wake (MessageCreate → sendPrompt)

Prompt shape (unchanged header + thin JSON; optional attachments):

```
d:<slug>:<messageId>
{"id":"d:<slug>:<messageId>","g":"<guildId|null>","u":"<userId>","map":"<alias>","a":[{"url":"...","filename":"...","contentType":"...","size":123}]}
<human text>
```

- Text-only wakes omit `a` (same as before).
- When the Discord message has attachments, thin JSON includes **`a`**: an array of URL refs (not base64) using Discord CDN `attachment.url` (fallback `proxyURL`), plus optional `filename`, `contentType`, `size`.
- The same refs are also placed on sendPrompt **`metadata.attachments`**.
- Attachment-only messages (no text) still wake.
- Cap: first 10 attachments.

### CDN lifetime caveat

Discord CDN / media proxy URLs **expire**. Agents should **fetch promptly** after the wake. Do not store these URLs long-term expecting them to stay valid.

## Local planner hop (optional, 0.2.9)

Default is unchanged: a channel-map row without the opt-in fields still calls Grok Bot `sendPrompt`.

A row opts into the local planner only when all three are set:

- `primary_llm`: `"local"`
- `wake_agent`: `false`
- `local_handler`: `"rumble-pixel-planner"`

Those rows do **not** call `sendPrompt`. The bridge posts a short message in the same channel, `Working on it.`, then POSTs this JSON to `LOCAL_PLANNER_URL` with `Authorization: Bearer <LOCAL_PLANNER_TOKEN>` (planner auth only; this is not the callback token):

```json
{
  "userPrompt": "<human text>",
  "imagePath": "<attachment[0] url or empty>",
  "referenceImagePath": "<attachment[1] url; omitted when absent>",
  "imagePaths": ["<attachment[0]>", "<attachment[1]>"],
  "channelId": "<discord channel id>",
  "slug": "<channel slug>",
  "messageId": "<inbound Discord message id>",
  "statusMessageId": "<Working on it. message id>",
  "callbackUrl": "<CALLBACK_BASE_URL + CALLBACK_PATH>",
  "dryRun": false
}
```

Image-edit hops forward at most two attachments: `imagePath` / `imagePaths[0]` is the base, and `referenceImagePath` / `imagePaths[1]` is the optional reference. Later attachments are ignored. Video behavior is unchanged (shared attachment forwarding only).

`messageId` is the inbound Discord message id for that hop. Do not send a placeholder. `statusMessageId` is the working message the bridge just posted, when that post succeeded. The same `messageId`, `callbackUrl`, and `statusMessageId` (when present) are set on the planner request query string, replacing any `messageId` already on `LOCAL_PLANNER_URL`. The callback token is **not** placed on that query string.

The bridge does **not** wait for generation to finish, and it does **not** abort the planner HTTP call. Aborting that call can stop a handler that is still tied to the connection. The timeout is not raised. A dropped connection, a timeout, or `fetch failed` after the hop was sent is not a final failure and does not add a red X. The accept check is unchanged: it is added only when that HTTP call returns ok. The working message is what the channel shows while the hop runs. There is no spinner reaction.

If the planner URL or token is blank, or the planner endpoint rejects the hop before work starts (HTTP 401, 403, or 404), the bridge edits the working message to `Couldn't start that.` That row still does not `sendPrompt`.

### How the hop posts output

The local handler must POST the result (text and/or image) to `callbackUrl`. That URL is the bridge's own callback endpoint: `CALLBACK_BASE_URL` joined with `CALLBACK_PATH` (default `/callback`). Example shape: `https://callback.example.com/callback`.

Auth on that POST is header-only:

- `Authorization: Bearer <CALLBACK_TOKEN>`, or
- header `x-callback-token: <CALLBACK_TOKEN>`

Do not put the callback token in a query string (`?token=` is rejected). Set `channelId` to the channel from the hop. Set `replyToMessageId` to the inbound `messageId`. Set `statusMessageId` to the working-message id from the hop when you have it. The bridge edits that working message (image on success, or the callback text on failure) instead of posting a second message. If `statusMessageId` is omitted, the bridge still edits the working message it stored for that `replyToMessageId`. If neither is available, it sends a new message as before. A handler that is not given the real message id and callback URL can exit successfully and never post.

Leave `agentId` as the real id (do not invent one).

## Callback contract (outbound)

Auth (**header-only** as of **0.2.4** — query `?token=` removed):

- `Authorization: Bearer <CALLBACK_TOKEN>`, or
- header `x-callback-token: <CALLBACK_TOKEN>`
- Missing or wrong token → **401** `unauthorized`
- Query `?token=` alone is **rejected** (use a header)

### Soft rate limit

`POST /callback` is soft-limited in-memory at **90 requests/minute** by default (override with `CALLBACK_RATE_LIMIT_PER_MIN`; `0` disables). Keys: hash of the callback token **and** client IP (either bucket tripping returns **429** + `Retry-After`). Ceiling is high so normal dual-deliver never trips; only abuse is logged and rejected. Does not crash the process.

### JSON (`Content-Type: application/json`)

Backward compatible text-only body still works. `content` is **optional** when there is ≥1 attachment.

```http
POST /callback
Authorization: Bearer <CALLBACK_TOKEN>
Content-Type: application/json

{
  "channelId": "<discord channel snowflake>",
  "content": "optional markdown-ish text",
  "replyToMessageId": "<optional>",
  "statusMessageId": "<optional, edit this message instead of sending>",
  "userId": "<optional>",
  "agentId": "<optional>",
  "attachments": [
    { "filename": "shot.png", "contentType": "image/png", "data": "<base64 no data-URL prefix>" },
    { "filename": "remote.jpg", "contentType": "image/jpeg", "url": "https://example.com/a.jpg" }
  ]
}
```

Attachment item (exactly one of `data` or `url`):

| Field | Required | Notes |
|-------|----------|-------|
| `filename` | required for `data`; optional for `url` | sanitized |
| `contentType` | optional | guessed from filename / fetch headers if omitted |
| `data` | xor `url` | raw base64 (data-URL prefix stripped if present) |
| `url` | xor `data` | **https only**; bridge fetches (~15s timeout) |

### multipart/form-data

| Part / field | Notes |
|--------------|-------|
| `channelId` | required |
| `content` | optional text |
| `replyToMessageId` | optional |
| `statusMessageId` | optional; edit this message instead of sending a new one |
| `files` or `files[]` | file parts (max 10) |

Prefer multipart for large binaries. JSON body limit is **12mb** (base64 overhead); multipart uses multer memory limits.

### Limits

| Limit | Value |
|-------|-------|
| Max files | 10 |
| Max per file | 8 MiB |
| Max total | 25 MiB |
| Allowed MIME | **Images/media:** `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `application/pdf`, `text/plain`. **Office:** `docx`/`xlsx`/`pptx` OOXML, legacy `doc`/`xls`/`ppt`, ODF `odt`/`ods`/`odp`, `application/rtf`, `text/csv`, `text/tab-separated-values`. **Text/code:** `text/markdown`, `text/html`, `text/css`, `text/javascript`, `application/javascript`, `application/json`, `application/xml`, `text/xml`, `application/x-yaml`, `text/yaml`, `text/x-python`, `application/x-python`, `text/x-shellscript`, `application/x-sh`, `application/x-powershell`, `text/x-powershell`. Extension fallback when `contentType` missing/`application/octet-stream`: `.md` `.json` `.xml` `.yml` `.yaml` `.py` `.ps1` `.sh` `.bash` `.csv` `.tsv` `.html` `.css` `.js` `.ts` `.docx` `.xlsx` `.pptx` `.doc` `.xls` `.ppt` `.odt` `.ods` `.odp` `.rtf` (plus existing image/media/pdf/txt). **Archives:** `application/zip`, `application/x-tar`/`application/tar`, `application/gzip`/`application/x-gzip`, `application/x-gtar`, `application/x-7z-compressed`, `application/vnd.rar`/`application/x-rar-compressed` (ext: `.zip` `.tar` `.gz` `.tgz` `.tar.gz` `.7z` `.rar`). **Still denied:** exe/msi/dmg/iso/appimage and other executables. |

Else **415** `unsupported_media_type`.

### Delivery

Uses discord.js `channel.send({ content?, files: AttachmentBuilder[], reply? })`, unless `statusMessageId` is set or this bridge stored a working message for `replyToMessageId`. In that case it edits that message (content and files) instead of sending a second one. If the edit fails, it falls back to `channel.send`. Attachments go on the **first** chunk/message; long text is still chunked (~1900 chars).

Success: `{ "ok": true, "messageId": "...", "chunks": N, "attachments": N }`.

### Error codes

| Code | When |
|------|------|
| `content_or_attachment_required` | neither text nor files (replaces strict `content_required`) |
| `channelId_required` | missing channel |
| `attachment_too_large` | per-file or total over cap |
| `too_many_attachments` | >10 files |
| `unsupported_media_type` | MIME not allowlisted (HTTP 415) |
| `attachment_fetch_failed` | URL fetch failed / timed out |
| `unauthorized` / `discord_not_ready` / `channel_not_found` / `deliver_failed` | unchanged |

### curl examples

Text only (legacy):

```bash
curl -sS -X POST "http://127.0.0.1:18083/callback" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channelId":"555555555555555555","content":"hello from bridge"}'
```

JSON + tiny PNG (1×1):

```bash
B64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
curl -sS -X POST "http://127.0.0.1:18083/callback" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channelId\":\"555555555555555555\",\"content\":\"png smoke\",\"attachments\":[{\"filename\":\"1x1.png\",\"contentType\":\"image/png\",\"data\":\"$B64\"}]}"
```

Multipart:

```bash
curl -sS -X POST "http://127.0.0.1:18083/callback" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" \
  -F "channelId=555555555555555555" \
  -F "content=multipart smoke" \
  -F "files=@./shot.png;type=image/png"
```

## Ports

| Port | Bind | Role |
|------|------|------|
| `18083` | `127.0.0.1` on host | Bridge HTTP (`/healthz`, `/callback`) |
| `1340` | Grok Bot computer (not this container) | `POST /api/sendPrompt` |

## Docker Compose

```bash
cd /path/to/grok-bot-discord-bridge
# Preserve live .env + config/security.json + config/channel-map.json
docker compose up -d --build
curl -sS http://127.0.0.1:18083/healthz   # discordReady: true
```

## Local develop

```bash
npm ci
npm test
npm run build
cp .env.example .env
HTTP_ONLY=1 HTTP_BIND=127.0.0.1 npm start   # HTTP only, no Discord
```

## License

MIT — Copyright (c) 2026 Matthew Rutledge. See [LICENSE](./LICENSE).

## Timing logs

Structured bottleneck timing (no tokens / no message content):

```
[timing] msg=<discordMessageId> hop=d:<slug>:<id> stage=authz ms=12 ok=true
[timing] msg=… hop=… stage=build_wake ms=1 attachments=2
[timing] msg=… hop=… stage=sendPrompt ms=45 ok=true
[timing] msg=<replyToMessageId> stage=callback_auth ms=0 ok=true
[timing] msg=… stage=callback_resolve ms=120 attachments=1 ok=true
[timing] msg=… stage=callback_deliver ms=80 ok=true chunks=1 attachments=1
[timing] msg=… stage=callback_total ms=210 idle_ms=3400 ok=true
```

`idle_ms` is wall-clock gap from sendPrompt accept → callback, joined on `replyToMessageId` when present.

