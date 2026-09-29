# grok-bot-discord-bridge

Thin **Discord Gateway → Grok Bot `sendPrompt` → Discord callback** bridge.

Portfolio repo for Matthew Rutledge. Designed for host **servergen1** (`192.168.86.236`) under `/opt/sites/discord-fleet-wake`.

**Still no live Discord** until a real bot token is placed in host `.env` (vault key `DISCORD_FLEET_WAKE` — document later). Without a real token the process exits cleanly after binding HTTP briefly; keep Compose **stopped** until go-live.

OpenClaw Discord remains untouched (already disabled).

## Architecture

```
Discord Gateway
    │  MessageCreate (deny-by-default authz)
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
    body: { "channelId": "...", "content": "...", "replyToMessageId"?: "..." }
    │
    ▼
Discord channel message
```

Local HTTP (loopback only via Compose publish):

| Path | Method | Purpose |
|------|--------|---------|
| `/healthz` | GET | Liveness + whether Discord is ready |
| `/callback` | POST | Agent → Discord delivery (token required) |

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

### Seed (OpenClaw shape — config only, not live)

| Field | Value |
|-------|--------|
| Guild | `949100784186966066` (KittenClubbers) |
| Users | `339560375924031498`, `354095575282614272` |
| Owner | `339560375924031498` |
| `requireMention` | `false` for that guild |

These IDs are **still denied in practice** until a real `DISCORD_BOT_TOKEN` is present and the service is started.

## Env

See [`.env.example`](./.env.example). Notable names:

- `DISCORD_BOT_TOKEN` — required for Gateway login
- `DISCORD_GUILD_ID`, `DISCORD_ALLOWFROM`, `DISCORD_ALLOW_ROLES`, `DISCORD_ALLOW_CHANNELS`, `DISCORD_OWNER_ID`, `DISCORD_DM_POLICY`
- `GROK_BOT_SENDPROMPT_URL` — default `http://host.docker.internal:1340/api/sendPrompt` on Docker hosts that support it (or use LAN IP of the Grok Bot computer)
- `GROK_BOT_GATEWAY_TOKEN` — optional Bearer for sendPrompt
- `CALLBACK_BASE_URL`, `CALLBACK_PATH`, `CALLBACK_TOKEN`
- `HTTP_BIND` / `HTTP_PORT` — container listens `0.0.0.0:18083`; Compose publishes `127.0.0.1:18083`

**Git never gets real secrets** — only `.env.example`. Host `.env` is local; vault key name to file later: `DISCORD_FLEET_WAKE`.

## channel-map schema

```json
{
  "version": 1,
  "defaultSendPromptUrl": null,
  "channels": [
    {
      "enabled": false,
      "channelId": "123",
      "label": "optional",
      "agentId": "",
      "sendPromptUrl": null,
      "requireMention": false
    }
  ]
}
```

Stub rows ship **disabled**. Enable a row only after choosing a real `agentId`.

## Callback contract

```http
POST /callback
Authorization: Bearer <CALLBACK_TOKEN>
Content-Type: application/json

{
  "channelId": "<discord channel snowflake>",
  "content": "markdown-ish text to post",
  "replyToMessageId": "<optional original message id>",
  "userId": "<optional>",
  "agentId": "<optional>"
}
```

Success: `{ "ok": true, "messageId": "...", "chunks": N }`. Long content is split near Discord’s limit.

## Ports

| Port | Bind | Role |
|------|------|------|
| `18083` | `127.0.0.1` on host | Bridge HTTP (`/healthz`, `/callback`) |
| `1340` | Grok Bot computer (not this container) | `POST /api/sendPrompt` |

Matches other `/opt/sites` apps (localhost-only publish, Cloudflare Tunnel if ever exposed).

## Docker Compose

```bash
cd /opt/sites/discord-fleet-wake
cp .env.example .env
# Fill secrets from vault DISCORD_FLEET_WAKE — do not start until token is real
docker compose config    # validate only
# Go live:
docker compose up -d --build
```

`restart: unless-stopped`. Without a real token the entrypoint exits with code `2` so a premature `up` will restart-loop — **leave the stack stopped** until `.env` is filled.

## Local develop

```bash
npm ci
npm run build
cp .env.example .env
HTTP_ONLY=1 HTTP_BIND=127.0.0.1 npm start   # HTTP only, no Discord
```

## Go live checklist

1. Create Discord application/bot; invite to guild with message content intent.
2. Put token + callback token in host `.env` (vault `DISCORD_FLEET_WAKE`).
3. Confirm Grok Bot computer accepts `POST :1340/api/sendPrompt` and can reach `CALLBACK_BASE_URL`.
4. Enable a `channel-map.json` row with a real `agentId`.
5. `docker compose up -d --build` on servergen1.
6. `curl -sS http://127.0.0.1:18083/healthz` → `discordReady: true`.

## License

Private portfolio use; no warranty.
