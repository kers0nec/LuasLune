# LuaLune

Luau/Lua protection platform built around the **Prometheus obfuscator**.

LuaLune takes a Lua or Luau script, protects it, and hands back a loader URL you can
paste into any executor. It ships with accounts, a key system, HWID whitelisting,
execution logs, workspace sharing and an admin console. Every account is unlimited:
no plans, no quotas and nothing to buy.

```
loadstring(game:HttpGet("https://<your-domain>/loader/<script-id>"))()
```

---

## Engines

| Engine | What it does |
| --- | --- |
| **Prometheus** (`prometheus`) | The AST-level obfuscator by Elias Oelschner, vendored under `vendor/prometheus` and driven by a WASM Lua VM. Default engine. |
| **None** (`none`) | Stores the script untouched, for open source scripts or diffing a build. |

The older LuaLune engines (payload, flow, vault) are gone. Existing scripts that
reference them are rebuilt with Prometheus, and legacy engine ids still resolve to it.

### Presets

| Profile | Steps (in order) | Notes |
| --- | --- | --- |
| `minify` | — | Source cleanup only. |
| `weak` | EncryptStrings, Vmify, ConstantArray, NumbersToExpressions, WrapInFunction | Fast builds, small output. |
| `medium` (default) | EncryptStrings, AntiTamper, Vmify, ConstantArray, NumbersToExpressions, WrapInFunction | The default balance of speed and strength. |
| `strong` | Vmify, EncryptStrings, AntiTamper, Vmify, ConstantArray, NumbersToExpressions, WrapInFunction | Can be 50x slower; use it for small, hot-path-free scripts. |

Aliases (`light` → weak, `balanced` → medium, `heavy`/`maximum` → strong) and unknown
profile ids all keep working. Builds are randomized: pass `seed` to get a reproducible
build (used by the tests), otherwise every build differs.

`luaVersion` picks the target dialect: `LuaU` (default, what executors run) or
`Lua51`. Hardening (`harden`, on by default) adds Prometheus' `AntiTamper` step, whose
builds are meant to run inside Roblox/executors rather than plain Lua.

### Vendor patches

The vendored Prometheus source carries a few LuaLune patches, each marked with a
`LuaLune patch (upstream fix pending)` comment:

- `prometheus/steps/NumbersToExpressions.lua` — the step verified its generated
  expressions with the host VM's exact 64-bit integers, while the emitted code runs
  in Lua 5.1/Luau where numbers are doubles. Any expression whose intermediate values
  passed 2^53 therefore checked out in the host and still evaluated differently at
  runtime, which made a share of builds decode their own strings into garbage. The
  checks now force double arithmetic (`toDouble(n) = n + 0.0`), and number
  representations are only rewritten when the target's doubles hold the value exactly.
- `prometheus/steps/NumbersToExpressions.lua` — the scientific representation used
  `%.15g`, which cannot round-trip every double; it now uses `%.17g` and falls back to
  the plain literal when the round-trip fails.
- `prometheus/unparser.lua` — number literals were printed with `tostring`, i.e. the
  host's `%.14g`, silently truncating any literal with more than 14 significant digits
  (3.3333333333333335 became 3.3333). Values that do not survive `tostring` are now
  re-emitted with `%.17g`.

## Quick start

```bash
npm install
npm start          # http://localhost:10000
npm test           # builds every profile and runs the output in a Lua VM
```

Without `SUPABASE_URL` / `SUPABASE_ANON_KEY` LuaLune runs fully self contained:
accounts, sessions and data live in memory, but auth accounts and session
signing are persisted to `data/auth-local.json`, so logins keep working across
restarts (set `LUALUNE_DATA_DIR` to move that file). Configure Supabase to make
everything else persistent too.

### Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `10000`, Render sets it automatically). |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Enables Supabase auth + Postgres storage. Run `schema.sql` once. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only admin key. Lets LuaLune confirm sign-ups itself, so username-only accounts work even with Supabase "Confirm email" enabled. |
| `LUALUNE_AUTH_SECRET` | Signs local session tokens when Supabase is not configured. Generated and persisted automatically when unset. |
| `LUALUNE_DATA_DIR` | Where local-mode auth state is persisted (default `./data`). |
| `LUALUNE_DOMAIN` | Domain shown in metadata and used for log hashing salt. |
| `LUALUNE_ADMINS` | Comma separated emails that always get admin access. |
| `LUALUNE_RATE_AUTH` / `LUALUNE_RATE_BUILD` / `LUALUNE_RATE_LOADER` | Per-window limits for sign-in/password-reset attempts (60 / 10 min), builds (30 / min) and loader requests (240 / min). Signup is not rate limited by LuaLune. |

Source files may be up to 500 KB — the limit of the Prometheus engine, advertised by
`GET /api/meta` as `maxSourceBytes`.

### Sign-in troubleshooting

- **"Invalid username or password" with a correct password** — the account is
  probably stuck unconfirmed in Supabase (see the email confirmation note above).
  Set `SUPABASE_SERVICE_ROLE_KEY` and restart: the next login attempt confirms
  and rescues the account automatically.
- **Accounts vanish after every deploy** — that instance is running without
  Supabase. Auth accounts survive restarts now, but scripts/keys need
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` to be persistent.
- **"Too many sign-in attempts"** — rate limited per IP (60 per 10 minutes);
  the error shows the wait.

---

## API

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | Health check → `LuaLune OK`. |
| `GET` | `/api/meta` | Brand, engines, profiles, attribution, source cap, terms version. |
| `GET` | `/api/tos`, `/api/announcements` | Public documents. |
| `POST` | `/api/auth/signup`, `/api/auth/login` | Username + password (email optional). |
| `GET` | `/api/auth/me`, `POST /api/auth/logout` | Session. |
| `POST` | `/api/tos/accept` | Accept the current terms version. |
| `GET/POST` | `/api/scripts` | List / create protected scripts. |
| `GET/PATCH/DELETE` | `/api/scripts/:id` | Read metadata, rename, toggle public, delete. |
| `POST` | `/api/scripts/:id/rebuild` | Re-obfuscate new source; the loader URL stays the same. |
| `GET` | `/api/scripts/:id/view` | The protected build as text (owner only). |
| `GET` | `/api/scripts/:id/logs` | Execution logs. |
| `GET/POST/DELETE` | `/api/keys` | Key system: `?duration=test\|1d\|3d\|7d\|30d\|forever`. |
| `GET/POST/DELETE` | `/api/whitelist` | HWID whitelist per script. |
| `GET/POST/DELETE` | `/api/invites`, `/api/invites/redeem` | Invite codes for workspace access. |
| `GET/POST/DELETE` | `/api/shares` | Workspace sharing. |
| `GET` | `/api/admin/*` | Stats, users, broadcast announcements. |
| `GET` | `/loader/:id?key=...&hwid=...` | What executors fetch. Runs the key, HWID and status checks, then returns the build. |

`loader/:id` answers with a plain-text Lua file in every case — a denial is a small
stub that calls `error()`, so an executor never sees a HTML error page.

---

## Layout

```
server.js              Express API, loader endpoint, static host
lib/prometheus.js      vendored Prometheus driver (WASM Lua VM), profiles, seeds, attribution
lib/engines.js         engine registry: prometheus + none, legacy ids -> prometheus
lib/plans.js           the single unlimited plan
lib/loader.js          loader banners, snippets and denial stubs
lib/ratelimit.js       fixed window rate limiting (api, builds, loader)
lib/auth.js            Supabase auth or built-in scrypt auth
lib/store.js           memory or Supabase storage adapter
lib/tos.js             terms of service text and version
vendor/prometheus/src  the engine itself (Prometheus License, see CREDITS)
index.html             gold themed single page app
styles.css             theme
tests/                 node:test suites incl. a Lua VM round-trip harness
schema.sql             Supabase schema + row level security
```

## Hardening

- Signup is direct: no CAPTCHA and no application-side account-creation throttle.
- Per-IP rate limits on sign-in/password-reset attempts, builds and the loader; a throttled loader call
  still returns Lua (a denial stub), never HTML.
- Loader requests are checked server side for key, expiry, key/script binding and
  HWID before any protected source leaves the server.
- Row level security in `schema.sql`; the browser never sees another user's rows.
- Sessions are bearer tokens (Supabase or HMAC signed locally, 30 day expiry).

## Tests

`tests/luavm.js` embeds a Lua 5.3 VM (fengari) so every generated build is
actually executed and its printed output is compared against the original script.

- `prometheus.test.js` — profile mapping, build output, anti-tamper, vendor health,
  and a regression test pinning the seeds that used to corrupt builds.
- `api.test.js` — the HTTP surface end to end: accounts, scripts, keys, whitelist,
  invites, shares, logs, loader denials and the unlimited-usage contract.
- `auth.test.js` / `ratelimit.test.js` — sign-in flows and the per-IP limiters.

## Credits and license

- LuaLune platform, dashboard and engine integration: this repository.
- The obfuscator is **Prometheus** by Elias Oelschner,
  https://github.com/prometheus-lua/Prometheus, used under the **Prometheus
  License** (not MIT). LuaLune ships a patched copy in `vendor/prometheus`; the
  patches are documented above, and the required attribution appears in
  `GET /api/meta`, in the dashboard footer and in the header of every build:

  ```
  Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus
  ```

- Obfuscated *output* carries no license notice requirement; only the engine source
  and its derivatives do.

## Legal

LuaLune is a protection tool. Users are responsible for what they protect with it.
See the in-app Terms of Service for the acceptable use rules.
