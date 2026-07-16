# Durable Owner Session (F04C)

Dale authenticates **once per device** and stays signed in across app-shell and
service-worker refreshes, without a raw API key sitting in browser `localStorage`.

## How it works

- On connect, the browser exchanges the Atlas key for a **signed, HttpOnly,
  Secure, SameSite=Lax** cookie (`atlas_session`, ~120-day lifetime). The raw
  key is then removed from `localStorage`. JavaScript cannot read or forge the
  cookie — the signing secret never leaves the server.
- Same-origin `/api` requests send the cookie automatically. State-changing
  (non-GET) requests additionally require a same-origin `Origin` (CSRF defense on
  top of `SameSite=Lax`).
- An actively-used session is **rotated** (re-issued) once it is past its
  half-life, so an active owner is not forced to re-authenticate on the hard
  boundary.

## Endpoints (all public, no key required to call)

| Route | Purpose |
|---|---|
| `POST /api/session/login` | Body `{ api_key }` → validates it, sets the cookie. `503` when sessions are disabled; `401` on a wrong key. |
| `POST /api/session/logout` | Clears the cookie (`Max-Age=0`). |
| `GET /api/session/status` | Reports `{ sessions_enabled, authenticated, expires_at }` — no secrets. |

Everything else under `/api` still requires **either** a valid session cookie
**or** the legacy `x-atlas-api-key` header. The header remains the path for
trusted local scripts/agents (they never scrape Dale's browser cookie) and for
the bounded migration window.

## Migration (automatic, one-time)

On load, if durable sessions are enabled and this browser still holds a
`localStorage` key, the app logs in with it once, receives the cookie, and deletes
the raw key. Nothing to do by hand.

## Activation (owner step)

Durable sessions are **off** until a signing secret is provisioned; until then the
app keeps using the `x-atlas-api-key` header exactly as before, so merging this is
safe with no behavior change.

To turn it on, set one Render environment variable on the Atlas service:

- **Name:** `ATLAS_SESSION_SECRET`
- **Value:** a fresh 32-byte random hex string. Generate it locally with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Then redeploy. (Never paste the value into the repo, a PR, logs, or a Sheet.)

Rotating `ATLAS_SESSION_SECRET` invalidates every existing session (all devices
must reconnect) — that is the deliberate lever for a global logout, since the
cookie is a stateless signed token.

## Limitations

- Logout clears the cookie in that browser. Because the token is stateless, a
  previously-captured token stays valid until it expires; rotate
  `ATLAS_SESSION_SECRET` for an immediate global invalidation.
- Sessions never widen access: an unauthenticated request still fails closed, and
  the public Control Tower status endpoint stays login-free by design.
