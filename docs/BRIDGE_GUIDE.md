# Zynd Bridge — New User Guide

Zynd Bridge is a local-first companion that turns your scattered context
(LinkedIn, mem0, Zep, what you're building) into a **privacy-tiered
findability card**, so the right people and AI agents can find you — without
leaking your private data. It also exposes a local **MCP server** so Claude
Desktop (or any MCP client) can read that context.

> **Core promise:** raw data stays on your machine (encrypted). Only what you'd
> put on a business card ever leaves.

---

## 1. Prerequisites

| Requirement | Needed for |
|---|---|
| Node.js ≥ 18 | everything |
| A Google account | `bridge init` sign-in |
| `uv` (Python) | LinkedIn connector only (auto-installs its deps) |
| LinkedIn account | `linkedin-auth` (optional) |
| mem0 / Zep API key | optional memory connectors |
| Claude Desktop / Cursor | MCP hosting (optional) |

---

## 2. Install

### Option A — npm (once `0.6.0` is published)

```bash
npm install -g zyndai
```

> ⚠️ As of this writing the registry still serves `0.5.7`, which does **not**
> include `zynd bridge`. Use Option B until the teammate publishes `0.6.0`.

### Option B — build from source (works today)

```bash
git clone https://github.com/zyndai/zyndai-ts-sdk
cd zyndai-ts-sdk
npm install
npm run build
npm link          # makes `zynd` available globally
```

Verify:

```bash
zynd --version    # should print 0.6.0
```

---

## 3. Identity

```bash
zynd auth whoami      # your developer identity (ID + public key)
zynd keys list        # developer key + derived agent keys
zynd keys show agent-0
```

---

## 4. The Bridge (personal memory → findability)

### 4.1 Init (sign in)

```bash
zynd bridge init
```

This walks you through:

1. memory-layer URL (default `https://api.zynd.ai`)
2. **Google sign-in** (OAuth2 — opens your browser, stores a token locally)
3. Optional providers: LinkedIn (`y/N`), mem0 (`y/N`), Zep (`y/N`)

Config is written to `~/.zynd/bridge.json` (mode `0600`).

### 4.2 Link LinkedIn (optional but the flagship flow)

```bash
zynd bridge linkedin-auth
```

Opens your default browser → log in with any method (Google/SSO/email) → the
`li_at` cookie is captured. **No password is ever stored.**

### 4.3 Sync

```bash
zynd bridge sync
```

Pulls from every configured provider, then:

1. **Redacts** PII/secrets/paths (10-layer engine)
2. **Classifies** facts into privacy tiers (0/1/2/3)
3. **Ingests** text → `api.zynd.ai/ingest` (private memory)
4. **Declares** Tier 0/1 facts → `/me/findability/declare-batch` (public card)
5. **Blocks** Tier 3 at the egress gate (never leaves your machine)

### 4.4 See your public card

```bash
zynd bridge card
```

### 4.5 Find similar people

```bash
zynd bridge match                     # full-context
zynd bridge match --cluster skill_cluster
zynd bridge match --cluster intent_cluster
```

> Requires **at least 5 public assertions** before matching returns results.

### 4.6 Seed demo facts (test without LinkedIn)

```bash
zynd bridge seed
```

Declares a demo persona of findability facts so you can test `match`
immediately. Idempotent — safe to re-run.

### 4.7 Daemon (auto-sync on interval)

```bash
zynd bridge start --interval 3600000   # sync every hour
zynd bridge stop
```

---

## 5. Memory connectors (mem0 / Zep)

Bridge can ingest memory you already have elsewhere.

```bash
zynd bridge init        # answer "y" to mem0 / Zep, paste the key
```

Or edit `~/.zynd/bridge.json` directly:

```json
{
  "providers": {
    "mem0": { "api_key": "m0-...", "user_id": "default" },
    "zep":  { "url": "https://api.getzep.com", "api_key": "zep_...", "user_id": "you" }
  }
}
```

Then `zynd bridge sync` fans out to all of them. `zynd bridge status` shows
provider health. mem0/Zep feed raw text to `/ingest`; the memory-layer extracts
structured facts server-side, which then appear as approve-able suggestions.

---

## 6. Host it as MCP (for Claude Desktop)

### 6.1 Start the local MCP server

```bash
zynd bridge mcp-local
```

Prints a config block and listens on `127.0.0.1` with a random bearer token.

### 6.2 Wire into Claude Desktop

```bash
zynd bridge mcp-setup            # writes claude_desktop_config.json (mode 0600)
# restart Claude Desktop
```

Then ask Claude: *"What do you know about me?"* — it will call
`get_my_context()` and answer from your synced context.

### 6.3 The 6 MCP tools

| Tool | Does |
|---|---|
| `zynd_bridge_status` | provider health + outbox depth |
| `zynd_persona_preview` | your assertions at a given tier |
| `zynd_context_sync` | trigger a sync from Claude |
| `zynd_linkedin_status` | LinkedIn governor + rate limits |
| `zynd_match_search` | find similar people |
| `zynd_remember` | save a local-only memory (never synced) |

> Security: the server binds loopback only, rejects non-loopback `Host`
> headers (DNS-rebinding protection), and requires the bearer token.

---

## 7. Registry lifecycle (register yourself as an agent)

```bash
zynd register --name my-agent --type agent --agent-url "https://my-agent.example.com"
zynd status --entity-id <id>
zynd info   --entity-id <id>
zynd search -q my-agent

# Naming
zynd name bind   --entity-id <id> --entity-name my-agent
zynd resolve @<your-handle>/my-agent     # shorthand works
zynd name unbind --entity-name my-agent
zynd deregister --entity-id <id>
```

---

## 8. Privacy tiers (what leaves vs what stays)

| Tier | Meaning | Example | Where it goes |
|---|---|---|---|
| 0 | Public card | role, skills, bio | public card |
| 1 | Discovery | expertise, location, "open to…" | public card |
| 2 | Gated | contact, work history | gated (consent) |
| 3 | **Never leaves** | shell commands, paths, secrets | blocked at egress |

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `LinkedIn session expired — run: zynd bridge linkedin-auth` | re-auth: `zynd bridge linkedin-auth` |
| `No matches yet — need at least 5 public assertions` | `zynd bridge seed` (or sync real data) |
| `zynd: command not found` | run `npm link` (or use `node dist/cli/index.js …`) |
| `deregister` HTTP 500 "zns_names_entity_id_fkey" | fixed in AgentDNS PR #23 — needs registry redeploy; workaround: `name unbind` first |
| `No user ID configured` | run `zynd bridge init` |
