# Twitch relay worker

Server-side Twitch token holder for peachyhodl.com/stream/chat. The browser
never sees a Twitch token — every token-touching Helix call goes through this
worker, which lives at `peachyhodl.com/twitch/*` (Cloudflare route on the
already-proxied zone; the site itself stays on GitHub Pages).

## Routes

| Route | Purpose |
|---|---|
| `GET /twitch/health` | liveness + configured mode (`refresh` / `manual` / `unconfigured`) |
| `GET /twitch/validate` | current token status, with admin-facing hints when invalid |
| `GET /twitch/broadcaster?login=peachyhodl` | broadcaster id for EventSub conditions |
| `POST /twitch/eventsub/subscriptions` | create a subscription bound to the visitor's EventSub WebSocket session (`{type, version, condition, session_id}`) |
| `GET /twitch/oauth/setup?key=…` | one-time: redirect the broadcaster (Peachy) through Twitch authorize |
| `GET /twitch/oauth/callback` | one-time: exchange the code, show the refresh token once |

## Secrets (never committed)

| Secret | Mode | Notes |
|---|---|---|
| `TWITCH_CLIENT_ID` | both | Twitch application client id |
| `TWITCH_CLIENT_SECRET` | optional | **not needed for Peachy's app** (Public client type — PKCE used instead). Only relevant if the app is ever switched to Confidential. |
| `TWITCH_REFRESH_TOKEN` | refresh (preferred) | long-lived; the worker auto-refreshes the access token. **Public client caveat:** refresh tokens expire after 30 days unless rotated — the worker's cron refreshes every 5 days, which re-issues a fresh refresh token, so the auth stays alive. Requires the `TWITCH_KV` binding. |
| `TWITCH_ACCESS_TOKEN` | manual (fallback) | pasted user token; expires (~4h for user tokens), admin re-pastes |
| `TWITCH_SETUP_KEY` | both | random string gating the OAuth setup flow |

All of them are stored as **GitHub repo secrets** and pushed to the worker by
the **“Twitch Secrets → Worker”** workflow (workflow_dispatch). Updating a
value = edit the repo secret → run the workflow.

## Admin setup (first time)

1. Repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Workers
   Routes:Edit, Workers KV Storage:Edit for the peachyhodl.com zone),
   `CLOUDFLARE_ACCOUNT_ID`, `TWITCH_CLIENT_ID`, `TWITCH_SETUP_KEY`.
   `TWITCH_CLIENT_SECRET` not needed — the app is a **Public** client type,
   so the worker uses PKCE.
   In the Twitch dev console, also add the redirect URI
   `https://peachyhodl.com/twitch/oauth/callback` to the app.
2. Run **Twitch Secrets → Worker** once (deploys worker + secrets + KV).
3. As Peachy (logged into Twitch), open
   `https://peachyhodl.com/twitch/oauth/setup?key=<TWITCH_SETUP_KEY>`,
   approve, and copy the refresh token the callback shows.
4. Paste it into repo secret `TWITCH_REFRESH_TOKEN` → run the workflow again.

After step 4: the worker refreshes the access token automatically, and the
every-5-days cron rotates the refresh token — Public clients' 30-day refresh
expiry never bites. Nobody touches it again unless the refresh grant is
revoked (password change / app disconnect → Peachy re-does steps 3–4).

## Scopes requested

`user:read:chat chat:read moderator:read:followers bits:read
channel:read:subscriptions offline_access`

`chat:edit` is deliberately NOT requested — the site never posts as Peachy.

## Local development

```sh
npx wrangler dev          # from worker/, with a .dev.vars file holding the secrets
```
