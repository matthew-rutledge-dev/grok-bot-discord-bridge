# grok-bot-discord-bridge

Thin **Discord Gateway → Grok Bot `sendPrompt` → Discord callback** bridge.

Portfolio repo for Matthew Rutledge. Live host **servergen1** (`192.168.86.236`) under `/opt/sites/grok-bot-discord-bridge`.

OpenClaw Discord remains untouched (already disabled). Bot identity: **Bender**.

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

### Seed (OpenClaw shape — config only)

| Field | Value |
|-------|--------|
| Guild | `949100784186966066` (KittenClubbers) |
| Users | `339560375924031498`, `354095575282614272` |
| Owner | `339560375924031498` |
| `requireMention` | `false` for that guild |

## Env

See [`.env.example`](./.env.example). Notable names:

- `DISCORD_BOT_TOKEN` — required for Gateway login
- `DISCORD_GUILD_ID`, `DISCORD_ALLOWFROM`, `DISCORD_ALLOW_ROLES`, `DISCORD_ALLOW_CHANNELS`, `DISCORD_OWNER_ID`, `DISCORD_DM_POLICY`
- `GROK_BOT_SENDPROMPT_URL` — default `http://host.docker.internal:1340/api/sendPrompt` on Docker hosts that support it (or use LAN IP of the Grok Bot computer)
- `GROK_BOT_GATEWAY_TOKEN` — optional Bearer for sendPrompt
- `CALLBACK_BASE_URL`, `CALLBACK_PATH`, `CALLBACK_TOKEN` (vault **`DISCORD_BRIDGE.callback_token`**)
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

## Callback contract (outbound)

Auth (unchanged):

- `Authorization: Bearer <CALLBACK_TOKEN>`, or
- header `x-callback-token: <CALLBACK_TOKEN>`

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

Uses discord.js `channel.send({ content?, files: AttachmentBuilder[], reply? })`. Attachments go on the **first** chunk/message; long text is still chunked (~1900 chars).

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
  -d '{"channelId":"1509247663646965770","content":"hello from bridge"}'
```

JSON + tiny PNG (1×1):

```bash
B64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
curl -sS -X POST "http://127.0.0.1:18083/callback" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channelId\":\"1509247663646965770\",\"content\":\"png smoke\",\"attachments\":[{\"filename\":\"1x1.png\",\"contentType\":\"image/png\",\"data\":\"$B64\"}]}"
```

Multipart:

```bash
curl -sS -X POST "http://127.0.0.1:18083/callback" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" \
  -F "channelId=1509247663646965770" \
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
cd /opt/sites/grok-bot-discord-bridge
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

Private portfolio use; no warranty.

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

