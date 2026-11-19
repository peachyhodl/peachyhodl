/**
 * Twitch relay worker for peachyhodl.com/stream/chat
 *
 * Holds the Twitch broadcaster token server-side so it never ships in the
 * public site bundle. The browser keeps its EventSub WebSocket (that part is
 * inherently public), but every token-touching Helix call goes through here.
 *
 * Env/secrets (set via `wrangler secret put` — managed from GitHub Secrets):
 *   TWITCH_CLIENT_ID      required — the Twitch application client id
 *   TWITCH_CLIENT_SECRET  optional — only needed for Confidential client
 *                         types; Peachy's app is Public (PKCE), no secret
 *   TWITCH_REFRESH_TOKEN  preferred — long-lived refresh token (offline_access),
 *                         auto-refreshes the access token; no manual upkeep
 *   TWITCH_ACCESS_TOKEN   fallback — manual user access token (expires ~60d);
 *                         admin re-pastes it when /twitch/validate reports expired
 *   TWITCH_SETUP_KEY      required for the one-time /twitch/oauth/setup flow
 *
 * KV binding TWITCH_KV (optional but recommended): caches the short-lived
 * access token between refreshes.
 */

export interface Env {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET?: string;
  TWITCH_REFRESH_TOKEN?: string;
  TWITCH_ACCESS_TOKEN?: string;
  TWITCH_SETUP_KEY?: string;
  TWITCH_KV?: KVNamespace;
}

const HELIX = 'https://api.twitch.tv/helix';
const ALLOWED_ORIGIN = 'https://peachyhodl.com';
const TOKEN_SKEW_S = 120; // refresh this early

interface CachedToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // unix seconds
  source: 'refresh' | 'manual';
}

interface TokenState {
  cached?: CachedToken;
  refreshing?: Promise<string>;
}

const state: TokenState = {};

function json(data: unknown, status = 200, origin?: string | null): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin === ALLOWED_ORIGIN || origin === 'http://localhost:5173' || origin?.startsWith('http://localhost:')) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-allow-methods'] = 'GET,POST,OPTIONS';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

/** Exchange the refresh token for a fresh access token. */
async function refreshAccessToken(env: Env): Promise<{ access: string; refresh?: string; expiresIn: number }> {
  // Twitch rotates refresh tokens on refresh ("refresh tokens may change —
  // store the new one"). The newest one lives in KV; the GitHub secret holds
  // the original bootstrap value. Prefer KV, fall back to the secret.
  let refreshToken = env.TWITCH_REFRESH_TOKEN ?? null;
  if (env.TWITCH_KV) {
    try {
      const raw = await env.TWITCH_KV.get('token');
      if (raw) {
        const t = JSON.parse(raw) as CachedToken;
        if (t.refresh_token) refreshToken = t.refresh_token;
      }
    } catch { /* fall back to env */ }
  }
  if (!refreshToken) {
    throw new Error('refresh-mode-not-configured');
  }
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    grant_type: 'refresh_token',
    // URLSearchParams form-encodes; the docs warn refresh tokens may contain
    // restricted characters and must be URL encoded.
    refresh_token: refreshToken,
  });
  // Confidential clients send their secret; Public clients (Peachy's app)
  // must NOT — PKCE-issued grants refresh with client_id alone.
  if (env.TWITCH_CLIENT_SECRET) {
    body.set('client_secret', env.TWITCH_CLIENT_SECRET);
  }
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) {
    throw new Error(`refresh-failed:${res.status}`);
  }
  return { access: data.access_token, refresh: data.refresh_token, expiresIn: data.expires_in ?? 3600 };
}

async function getToken(env: Env, forceRefresh = false): Promise<string> {
  // 1. KV cache
  if (!forceRefresh && env.TWITCH_KV) {
    try {
      const raw = await env.TWITCH_KV.get('token');
      if (raw) {
        const t = JSON.parse(raw) as CachedToken;
        if (t.expires_at - TOKEN_SKEW_S > Date.now() / 1000) return t.access_token;
      }
    } catch { /* fall through */ }
  }
  // 2. in-isolate cache
  if (!forceRefresh && state.cached && state.cached.expires_at - TOKEN_SKEW_S > Date.now() / 1000) {
    return state.cached.access_token;
  }
  // 3. manual token (no expiry knowledge — used as-is)
  if (!forceRefresh && env.TWITCH_ACCESS_TOKEN) {
    return env.TWITCH_ACCESS_TOKEN;
  }
  // 4. refresh grant
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    const r = await refreshAccessToken(env);
    const t: CachedToken = {
      access_token: r.access,
      refresh_token: r.refresh,
      expires_at: Math.floor(Date.now() / 1000) + r.expiresIn,
      source: 'refresh',
    };
    state.cached = t;
    if (env.TWITCH_KV) {
      await env.TWITCH_KV.put('token', JSON.stringify(t), { expirationTtl: r.expiresIn + 60 });
    }
    return r.access;
  })();
  try {
    return await state.refreshing;
  } finally {
    state.refreshing = undefined;
  }
}

/** Authenticated Helix GET/POST with one automatic refresh+retry on 401. */
async function helix(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = async (token: string) =>
    fetch(`${HELIX}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': env.TWITCH_CLIENT_ID,
        ...(init.headers ?? {}),
      },
    });
  let res = await doFetch(await getToken(env));
  if (res.status === 401 && (env.TWITCH_REFRESH_TOKEN || env.TWITCH_KV)) {
    res = await doFetch(await getToken(env, true));
  }
  return res;
}

function origin(req: Request): string | null {
  return req.headers.get('origin');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin(req) ?? '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
        },
      });
    }

    if (!url.pathname.startsWith('/twitch/')) {
      return json({ error: 'not-found' }, 404, origin(req));
    }
    if (!env.TWITCH_CLIENT_ID) {
      return json({ error: 'not-configured', hint: 'admin: set TWITCH_CLIENT_ID secret and redeploy' }, 503, origin(req));
    }

    const route = url.pathname;

    // ── health ──────────────────────────────────────────────────────────
    if (route === '/twitch/health') {
      return json({
        ok: true,
        mode: env.TWITCH_REFRESH_TOKEN ? 'refresh' : env.TWITCH_ACCESS_TOKEN ? 'manual' : 'unconfigured',
      }, 200, origin(req));
    }

    // ── validate: what does the admin need to know? ─────────────────────
    if (route === '/twitch/validate') {
      try {
        const token = await getToken(env);
        const res = await fetch('https://id.twitch.tv/oauth2/validate', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { login?: string; expires_in?: number; scopes?: string[] };
        if (!res.ok) {
          return json({ valid: false, status: res.status, hint: 'admin: update the Twitch secrets in GitHub and re-run the deploy workflow' }, 200, origin(req));
        }
        return json({ valid: true, login: data.login, expires_in: data.expires_in, scopes: data.scopes }, 200, origin(req));
      } catch (e) {
        return json({ valid: false, error: (e as Error).message, hint: 'admin: check TWITCH_REFRESH_TOKEN / TWITCH_CLIENT_SECRET secrets' }, 200, origin(req));
      }
    }

    // ── broadcaster lookup ──────────────────────────────────────────────
    if (route === '/twitch/broadcaster') {
      const login = url.searchParams.get('login') || 'peachyhodl';
      if (!/^[a-zA-Z0-9_]{3,25}$/.test(login)) {
        return json({ error: 'bad-login' }, 400, origin(req));
      }
      const res = await helix(env, `/users?login=${login}`);
      if (!res.ok) {
        return json({ error: 'helix-error', status: res.status }, res.status, origin(req));
      }
      const data = await res.json() as { data?: Array<{ id: string; login: string; display_name: string }> };
      const user = data.data?.[0];
      if (!user) return json({ error: 'broadcaster-not-found' }, 404, origin(req));
      return json({ id: user.id, login: user.login, display_name: user.display_name }, 200, origin(req));
    }

    // ── create an EventSub subscription bound to a browser WS session ──
    if (route === '/twitch/eventsub/subscriptions' && req.method === 'POST') {
      let body: { type?: string; version?: string; condition?: Record<string, string>; session_id?: string };
      try {
        body = await req.json() as typeof body;
      } catch {
        return json({ error: 'bad-json' }, 400, origin(req));
      }
      const { type, version, condition, session_id } = body;
      if (!type || !version || !condition || !session_id) {
        return json({ error: 'missing-fields', required: ['type', 'version', 'condition', 'session_id'] }, 400, origin(req));
      }
      const res = await helix(env, '/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          version,
          condition,
          transport: { method: 'websocket', session_id },
        }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        return json({ error: 'subscription-failed', status: res.status, detail: data }, res.status, origin(req));
      }
      return json({ ok: true, total_cost: (data as { total_cost?: number }).total_cost, max_total_cost: (data as { max_total_cost?: number }).max_total_cost }, 200, origin(req));
    }

    // ── one-time setup: broadcaster authorize + code exchange ──────────
    if (route === '/twitch/oauth/setup' && req.method === 'GET') {
      if (!env.TWITCH_SETUP_KEY || url.searchParams.get('key') !== env.TWITCH_SETUP_KEY) {
        return json({ error: 'forbidden' }, 403, origin(req));
      }
      // PKCE — required for Public client types (no client secret), harmless
      // for Confidential. The verifier is stored server-side (KV) and never
      // touches the URL.
      const random = new Uint8Array(64);
      crypto.getRandomValues(random);
      const b64url = (buf: ArrayBuffer | Uint8Array) =>
        btoa(String.fromCharCode(...new Uint8Array(buf as Uint8Array)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const verifier = b64url(random);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

      const state = crypto.randomUUID();
      if (!env.TWITCH_KV) {
        if (env.TWITCH_CLIENT_SECRET) {
          // Confidential mode: classic exchange works without KV.
        } else {
          return json({ error: 'kv-required', hint: 'admin: public client type needs the TWITCH_KV binding (see worker/README.md)' }, 503, origin(req));
        }
      } else {
        await env.TWITCH_KV.put(`pkce:${state}`, verifier, { expirationTtl: 600 });
      }

      const scopes = 'user:read:chat chat:read moderator:read:followers bits:read channel:read:subscriptions offline_access';
      const params = new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        redirect_uri: `${url.origin}/twitch/oauth/callback`,
        response_type: 'code',
        scope: scopes,
        state,
      });
      if (env.TWITCH_KV) {
        params.set('code_challenge', challenge);
        params.set('code_challenge_method', 'S256');
      }
      return Response.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`, 302);
    }

    if (route === '/twitch/oauth/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code');
      if (!env.TWITCH_SETUP_KEY || !state || !code) {
        return json({ error: 'forbidden-or-incomplete' }, 403, origin(req));
      }
      // PKCE verifier proves the callback belongs to a setup flow we started.
      let verifier: string | null = null;
      if (env.TWITCH_KV) {
        verifier = await env.TWITCH_KV.get(`pkce:${state}`);
        if (verifier) await env.TWITCH_KV.delete(`pkce:${state}`);
      }
      if (!verifier && !env.TWITCH_CLIENT_SECRET) {
        return json({ error: 'forbidden-or-incomplete' }, 403, origin(req));
      }
      const body = new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/twitch/oauth/callback`,
      });
      if (env.TWITCH_CLIENT_SECRET) {
        body.set('client_secret', env.TWITCH_CLIENT_SECRET);
      } else if (verifier) {
        body.set('code_verifier', verifier);
      }
      const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
      const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!res.ok || !data.refresh_token) {
        return json({ error: 'exchange-failed', status: res.status, detail: data }, 502, origin(req));
      }
      return new Response(
        `<!doctype html><title>Twitch setup complete</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h2>✅ Refresh token received</h2>` +
        `<p>Copy this into the <b>TWITCH_REFRESH_TOKEN</b> GitHub secret, then run the <b>Twitch Secrets → Deploy</b> workflow:</p>` +
        `<pre style="background:#111;color:#0f0;padding:1rem;overflow-wrap:anywhere;user-select:all">${data.refresh_token}</pre>` +
        `<p style="color:#a00">This token is shown once. Do not share this URL.</p></body>`,
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } },
      );
    }

    return json({ error: 'unknown-route' }, 404, origin(req));
  },

  // Public client types: refresh tokens expire after 30 days unless they are
  // rotated before then. Refreshing issues a fresh 30-day refresh token, so a
  // periodic refresh keeps the authorization alive indefinitely.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Refresh mode only (bootstrap refresh token required; rotated tokens are
    // persisted in KV by the refresh path above).
    if (!env.TWITCH_REFRESH_TOKEN) return;
    if (!env.TWITCH_KV) {
      console.error('keepalive skipped: TWITCH_KV binding missing — public-client refresh tokens would not be persisted');
      return;
    }
    ctx.waitUntil(
      getToken(env, true).catch((e) => console.error('keepalive refresh failed:', (e as Error).message)),
    );
  },
};
