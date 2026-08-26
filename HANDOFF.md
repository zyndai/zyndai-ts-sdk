# @zynd/ctx SDK — Full Handoff Document

## What This Is

`@zynd/ctx` is a CLI + SDK for syncing user context (LinkedIn profile, connections, mem0, Zep) into the **Zynd memory-layer** (`api.zynd.ai`), which stores facts about the user and powers agent-to-agent findability via AgentDNS.

CLI binary: `zynd ctx <command>`
Built from: `/Users/sahil/zynd/zyndai-ts-sdk`
Config stored: `~/.zynd/ctx.json` (mode 0600)

---

## Servers

| Server | IP | Role |
|--------|----|------|
| `api.zynd.ai` | `54.147.91.20` | Memory-layer (FastAPI). All ctx commands talk here. |
| `zns01.zynd.ai` | — | AgentDNS registry. Card updates go here. |
| `13.219.55.137` | — | Persona/deployer server. NOT the memory-layer. Ignore for ctx work. |

---

## Auth Flow (OAuth2 PKCE)

`zynd ctx init` runs full OAuth2 PKCE against the memory-layer:

1. `POST /oauth/register` → DCR, gets `client_id`
2. Redirects user to `GET /oauth/authorize?...` in browser → user signs in with Google (Supabase)
3. Local HTTP server on `127.0.0.1:<random-port>/callback` captures the `code`
4. `POST /oauth/token` with `code` + `code_verifier` → gets `access_token` + `refresh_token`
5. JWT `sub` claim = `user_id`

Tokens stored in `~/.zynd/ctx.json`:
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "oauth_client_id": "...",
  "user_id": "f342fa98-5b2c-45c1-98ce-b1679eeb30af"
}
```

Token auto-refresh: `MemoryClient.bearerToken()` checks `exp` claim, refreshes 60s before expiry, persists via `onTokenRefresh` callback.

**No hardcoded secrets.** Removed: `dev-jwt-secret-change-me-in-production`, `Bearer dev-secret`, `/me/whoami` probe (returns 404). Health check now uses `GET /health`.

---

## Key Source Files

```
src/ctx/
  oauth.ts              — Full PKCE OAuth2 flow (DCR, challenge, callback server, exchange)
  config.ts             — loadCtxConfig, saveCtxConfig, discoverMemoryLayer, getAccessToken
  memory-client.ts      — MemoryClient class: bearerToken(), ingestText(), declareBatch(), getCard()
  types.ts              — CtxConfig, IMemoryConnector, DistillResult, SyncResult interfaces
  sync.ts               — sync() orchestrator: fan-out → ingest → declare → card update
  distiller.ts          — runDistiller(): fans out to connectors, merges results
  connectors/
    linkedin.ts         — LinkedInConnector + AUTH_SCRIPT + SYNC_SCRIPT (Python via uv)
    mem0.ts             — Mem0Connector
    zep.ts              — ZepConnector
    zynd-native.ts      — ZyndNativeConnector (calls memory-layer directly)

src/cli/
  ctx.ts                — All CLI commands: init, sync, linkedin-auth, status, card, match
  linkedin-setup.ts     — promptLinkedInBrowserAuth() wrapper
```

---

## `~/.zynd/ctx.json` Schema

```json
{
  "providers": {
    "linkedin": {
      "li_at": "AQEDAWnu...",       // LinkedIn session cookie (152 chars, starts with AQED)
      "jsessionid": "ajax:091..."   // LinkedIn CSRF token (no quotes, starts with ajax:)
    },
    "mem0": { "api_key": "...", "user_id": "..." },
    "zep":  { "url": "...", "api_key": "...", "user_id": "..." }
  },
  "memory_url": "https://api.zynd.ai",
  "registry_url": "https://zns01.zynd.ai",
  "user_id": "f342fa98-5b2c-45c1-98ce-b1679eeb30af",
  "access_token": "...",
  "refresh_token": "...",
  "oauth_client_id": "..."
}
```

---

## LinkedIn Connector — How It Works

### Auth (`zynd ctx linkedin-auth`)

Runs `AUTH_SCRIPT` (inline Python) via `uv run`:
1. Tries to read `li_at` + `JSESSIONID` from Chromium/Firefox cookie DBs
   - Chromium: SQLite + AES-128-CBC decrypt via macOS Keychain
   - Firefox: plain SQLite
2. If auto-read fails (Arc, new Chrome encrypt differently) → prompts user to paste both cookies from DevTools
3. Returns `{ li_at, jsessionid }` as JSON on stdout

### Known Arc Bug (FIXED in code)

Arc's cookie decryption garbles the first AES block (16 bytes) — the IV handling differs. Result: garbage bytes prepended to the real cookie value.

**Both `li_at` AND `JSESSIONID` are affected.**

Fix applied in:
- `AUTH_SCRIPT`: `_clean_cookies()` function strips garbage using regex
- `SYNC_SCRIPT`: cleans both at startup
- `ctx.json`: already fixed with python3 one-liner

Patterns used to extract valid values:
- `li_at`: `AQED[A-Za-z0-9_-]+` (LinkedIn tokens always start with AQED)
- `JSESSIONID`: `ajax:\d+` (LinkedIn CSRF tokens always start with ajax:)

### Sync (`zynd ctx sync`)

Runs `SYNC_SCRIPT` (inline Python) via `uv` with env vars:
- `LI_AT` = cleaned li_at
- `LI_JSESSIONID` = cleaned jsessionid
- `LI_LIMIT` = connection limit (default 100)

Script:
1. Cleans both cookie values (Arc garbage strip)
2. Builds `RequestsCookieJar` WITHOUT domain/path qualifiers (avoids `DefaultCookiePolicy.return_ok_domain` filtering)
3. Sets `csrf-token` header from JSESSIONID: `jar["JSESSIONID"].strip('"')` → `ajax:091...`
4. Calls `open-linkedin-api` with `Linkedin("", "", cookies=jar, authenticate=True)`
5. Fetches: `get_user_profile()`, `get_profile()`, `get_profile_connections(limit=100)`
6. Returns JSON: `{ profile_text, connections: [{name, headline, location, url}] }`

### Errors Fixed This Session

| Error | Cause | Fix |
|-------|-------|-----|
| `'latin-1' codec can't encode character 'ޖ'` | LinkedIn redirects to profile URLs with Thaana/Arabic/CJK script. `http.client.putheader` validates headers as latin-1. | Monkey-patch `putheader` to percent-encode non-latin-1 chars |
| `'dict' object has no attribute 'extract_cookies'` | Passing plain dict instead of `RequestsCookieJar` | Build proper `RequestsCookieJar` |
| `Exceeded 30 redirects` | JSESSIONID corrupted → wrong `csrf-token` header → LinkedIn rejects all API calls | Fixed: regex-extract valid `ajax:\d+` from corrupted value; also fixed `li_at` same way |

---

## CLI Commands

```bash
zynd ctx init           # OAuth2 sign-in + optional LinkedIn auth
zynd ctx sync           # Fan-out to all connectors, ingest to memory-layer
zynd ctx linkedin-auth  # Re-auth LinkedIn (prompts for li_at + JSESSIONID from DevTools)
zynd ctx status         # Show what's configured
zynd ctx card           # Show public findability card
zynd ctx match          # Find similar users in Zynd network
```

---

## Memory-Layer API Endpoints Used

All requests: `Authorization: Bearer <access_token>` (OAuth2 JWT)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Reachability probe |
| POST | `/ingest` | Ingest text blobs into private memory |
| POST | `/me/findability/declare-batch` | Declare public findability facts |
| GET | `/me/findability` | Get current findability card |
| GET | `/match/:userId` | Find similar users |
| POST | `/oauth/register` | DCR: register new OAuth client |
| GET | `/oauth/authorize` | Redirect user to Google sign-in |
| POST | `/oauth/token` | Exchange code for tokens / refresh |

---

## Python Dependencies (for LinkedIn connector)

Installed via `uv run --with`:
- `cryptography` — AES-128-CBC for Chromium cookie decryption
- `open-linkedin-api` — Voyager API wrapper
- `requests` — HTTP client (open-linkedin-api dep)

---

## Current State

**Working:**
- `zynd ctx init` → OAuth2 sign-in with Google ✓
- `zynd_native` connector syncs ✓
- Token auto-refresh ✓
- All hardcoded secrets removed ✓

**LinkedIn sync: should work now** (ctx.json fixed with clean li_at + jsessionid)

To verify, run: `zynd ctx sync`

If it still fails with 30 redirects after the ctx.json fix: the `li_at` may have expired (LinkedIn sessions last ~1 year but can be invalidated). Run `zynd ctx linkedin-auth` again to capture fresh cookies.

---

## Build

```bash
cd /Users/sahil/zynd/zyndai-ts-sdk
npm run build   # tsup: outputs dist/cli/index.js (CJS) + dist/index.d.ts
```

Warning about `import.meta` is pre-existing and unrelated to ctx work.
