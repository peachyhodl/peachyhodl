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
| `TWITCH_CLIENT_SECRET` | both | required for refresh mode + setup flow |
| `TWITCH_REFRESH_TOKEN` | refresh (preferred) | long-lived; the worker auto-refreshes the access token |
| `TWITCH_ACCESS_TOKEN` | manual (fallback) | pasted user token; expires ~60d, admin re-pastes |
| `TWITCH_SETUP_KEY` | both | random string gating the OAuth setup flow |

All of them are stored as **GitHub repo secrets** and pushed to the worker by
the **“Twitch Secrets → Worker”** workflow (workflow_dispatch). Updating a
value = edit the repo secret → run the workflow.

## Admin setup (first time)

1. Repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit for the
   peachyhodl.com zone), `CLOUDFLARE_ACCOUNT_ID`, `TWITCH_CLIENT_ID`,
   `TWITCH_CLIENT_SECRET`, `TWITCH_SETUP_KEY`.
2. Run **Twitch Secrets → Worker** once (deploys worker + secrets).
3. Create the KV namespace and uncomment it in `wrangler.toml` (recommended —
   caches the access token between refreshes):
   `npx wrangler kv namespace create TWITCH_KV`
4. As Peachy (logged into Twitch), open
   `https://peachyhodl.com/twitch/oauth/setup?key=<TWITCH_SETUP_KEY>`,
   approve, and copy the refresh token the callback shows.
5. Paste it into repo secret `TWITCH_REFRESH_TOKEN` → run the workflow again.

After step 5 the token refreshes itself; nobody touches it again unless the
refresh token is revoked.

## Scopes requested

`user:read:chat chat:read moderator:read:followers bits:read
channel:read:subscriptions offline_access`

`chat:edit` is deliberately NOT requested — the site never posts as Peachy.

## Local development

```sh
npx wrangler dev          # from worker/, with a .dev.vars file holding the secrets
```
