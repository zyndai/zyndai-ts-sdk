# Zynd AI Network — Combined Repo Map

> Generated: 2026-04-27. Three repos explored; `agentdns` does not exist at the expected path — only two repos mapped.

---

## Repo 1 — `zyndai-ts-sdk` (TypeScript SDK)

**Package name:** `zyndai` (npm) v0.2.0
**CLI bin:** `zynd` → `dist/cli/index.js`
**Purpose:** TypeScript/JavaScript SDK for building agents and services on the Zynd AI Network. Ed25519 identity, decentralized registry, Entity Cards, WebSocket heartbeat, HTTP webhooks (Express), x402 micropayments, multi-framework LLM support. The CLI also scaffolds Python projects (mirrors `zyndai-agent`).

**Entrypoints**
- Library: `src/index.ts` → dual ESM/CJS (`dist/index.mjs` / `dist/index.js`)
- CLI: `src/cli/index.ts` → `dist/cli/index.js` (CJS, fully bundled — `noExternal: [/.*/]`)
- Build: `tsup.config.ts` — two tsup targets; `onSuccess` hook copies `src/templates/**/*.tpl` → `dist/templates/`

**Scripts**

| Command | Purpose |
|---|---|
| `npm run build` | tsup + chmod +x dist/cli/index.js |
| `npm run dev` | tsup --watch |
| `npm run test` | vitest run |
| `npm run lint` | tsc --noEmit |

---

### Directory Tree

#### `src/`

- `index.ts` — Public API barrel: re-exports all classes, types, functions, and `VERSION = "0.2.0"`
- `types.ts` — Zod schemas (`ZyndBaseConfigSchema`, `AgentConfigSchema`, `ServiceConfigSchema`) and TS interfaces (`EntityCard`, `AgentMessage`, `SearchResult`, `DerivationProof`, `AgentFramework` enum)
- `base.ts` — `ZyndBase` class: shared constructor (accepts `entityType` explicitly so subclass field initializers don't race), keypair resolution, heartbeat WebSocket (30s signed pings, second-precision timestamps `YYYY-MM-DDTHH:MM:SSZ`), registry upsert on `start()` (`getEntity` → register → 409 fallback to update), loopback URL warning, card serving, x402 setup; `ValidationOptions` interface
- `agent.ts` — `ZyndAIAgent extends ZyndBase`: framework setters (`setLangchainAgent`, `setLanggraphAgent`, `setCrewAgent`, `setPydanticAiAgent`, `setVercelAiAgent`, `setMastraAgent`, `setCustomAgent`), `invoke()` dispatcher with duck-typed interfaces for each framework
- `service.ts` — `ZyndService extends ZyndBase`: `setHandler(fn)` wires fn into webhook message handler; `invoke(inputText)` calls fn directly
- `identity.ts` — `Ed25519Keypair` class, `generateKeypair`, `loadKeypair`, `saveKeypair`, `generateEntityId(pubKey, entityType)` — returns `zns:<sha256[:16].hex>` for agents, `zns:svc:<sha256[:16].hex>` for services, `generateDeveloperId` (`zns:dev:…`), `sign`, `verify`, `deriveAgentKeypair` (SHA-512, prefix `"zns:agent:"`), `createDerivationProof`, `verifyDerivationProof`; keypair path resolution priority
- `webhook.ts` — `WebhookCommunicationManager`: Express server with `/webhook` (async), `/webhook/sync` (30s timeout), `/health`, `/.well-known/agent.json`; Zod `payloadModel`/`outputModel` validation; x402 middleware; `DEFAULT_MAX_FILE_SIZE_BYTES = 25 MiB`
- `registry.ts` — `DNSRegistryClient` namespace: `registerEntity`, `updateEntity`, `deleteEntity`, `getEntity`, `getEntityCard`, `searchEntities`, `resolveEntity`; signs requests with Ed25519; `canonicalJson` (sorted keys, matches Go `encoding/json`)
- `search.ts` — `SearchAndDiscoveryManager` class wrapping `registry.searchEntities` with camelCase API
- `message.ts` — `AgentMessage` class: `content`, `senderId`, `receiverId`, `messageType`, `messageId`, `conversationId`, `metadata`, `timestamp`; `toDict()` (snake_case + `prompt` alias for compat), `fromDict()`, `toJson()`, `fromJson()`
- `payment.ts` — `X402PaymentProcessor`: derives EVM account from Ed25519 private key via `SHA-256`; wraps `viem` `privateKeyToAccount`; `maxPaymentUsd` cap
- `crypto.ts` — `encryptMessage` / `decryptMessage`: X25519-AES256-GCM with HKDF (`"agdns:encryption:v1"`) — wire-compatible with Python SDK
- `entity-card.ts` — `buildEndpoints`, `buildEntityCard`, `signEntityCard`, `canonicalJson`
- `entity-card-loader.ts` — `loadEntityCard`, `resolveKeypair`, `buildRuntimeCard`, `computeCardHash` (hashes name/description/capabilities/tags/pricing/summary for change detection), `resolveCardFromConfig`, `loadDerivationMetadata`; `StaticEntityCard` interface
- `config-manager.ts` — `ConfigManager`: reads/writes `.agent/config.json`; `buildEntityUrl` helper
- `payload-schema.ts` — `zodToAdvertisedJsonSchema` (minimal Zod → JSON Schema, no external dep), `zodSchemaAdvertisement`; advertises `input_schema`/`output_schema` in Entity Card

#### `src/cli/`

- `index.ts` — Commander `zynd` program; registers all subcommands; parses `--registry` global option
- `init.ts` — `zynd init`: generates developer Ed25519 keypair → `~/.zynd/developer.json`
- `auth.ts` — `zynd auth login`: browser-based onboarding (local HTTP server, OAuth-style callback, AES-GCM-encrypted keypair from registry); `zynd auth whoami`
- `agent.ts` — `zynd agent init` (interactive lang/framework/name picker → scaffold) + `zynd agent run` (detect TS/Python, spawn runtime, health-check, register)
- `service.ts` — `zynd service init` + `zynd service run` — same flow as agent but for services
- `scaffold-ts.ts` — `parseDepsFromInstall`, `writeTsConfig`, `writeTsPackageJson`, `writeGitignore`; pinned TS/langchain versions
- `scaffold-identity.ts` — `scaffoldIdentity`: loads or HD-derives keypair at next free index; returns `ScaffoldIdentityResult`
- `prompts.ts` — `pickOption` / `promptText`: raw-mode arrow-key TUI (no external deps); falls back on non-TTY
- `config.ts` — `zyndDir`, `ensureZyndDir`, `developerKeyPath`, `agentsDir`, `servicesDir`, `agentKeypairPath`, `serviceKeypairPath`, `getRegistryUrl`, `saveCliConfig`
- `keys.ts` — `zynd keys list/create/derive/show`
- `register.ts` — `zynd register`: one-shot entity registration with derivation proof
- `deregister.ts` — `zynd deregister --entity-id`: calls `deleteEntity`
- `search.ts` — `zynd search` with `--category`, `--tags`, `--skills`, `--protocols`, `--languages`, `--models`, `--min-trust`, `--federated`, `--enrich`, `--json`
- `card.ts` — `zynd card show` / `zynd card validate`
- `resolve.ts` — `zynd resolve <fqan>`: resolve FQAN to entity
- `status.ts` — `zynd status --entity-id`: entity liveness
- `info.ts` — `zynd info --entity-id`: full entity details + card

#### `src/templates/`

- `frameworks.ts` — `FRAMEWORKS_BY_LANG`, `FRAMEWORK_ORDER_BY_LANG`, `LANGUAGES`, `LANGUAGE_LABELS`; install commands + env keys per framework; `templateFileForFramework`, `payloadTemplateFile`, `serviceTemplateFile`, `entryExtension`

**`src/templates/ts/*.tpl`** — TypeScript scaffold templates:
- `langchain.ts.tpl` — LangChain.js agent with memory + Tavily search
- `langgraph.ts.tpl` — LangGraph.js compiled graph agent
- `crewai.ts.tpl` — CrewAI-style researcher+analyst on LangChain.js
- `pydantic_ai.ts.tpl` — Zod + Vercel AI `generateObject` for typed outputs
- `vercel_ai.ts.tpl` — Vercel AI SDK tool-calling + streaming
- `mastra.ts.tpl` — Mastra framework agent
- `custom.ts.tpl` — Minimal custom `handleRequest`
- `service.ts.tpl` — Service handler
- `payload.ts.tpl` — Zod `RequestPayload`/`ResponsePayload` + `MAX_FILE_SIZE_BYTES`

**`src/templates/py/*.tpl`** — Python scaffold templates (TS CLI writes these for `--lang py`):
- `langchain.py.tpl`, `langgraph.py.tpl`, `crewai.py.tpl`, `pydantic_ai.py.tpl`, `custom.py.tpl` — Python agent templates (copies of `zyndai-agent/zynd_cli/templates/`)
- `service.py.tpl`, `payload.py.tpl`

#### `tests/`

All tests use **vitest**. Import from `src/` directly.

- `identity.test.ts` — `Ed25519Keypair`, sign/verify, `deriveAgentKeypair`, `createDerivationProof`, `verifyDerivationProof`
- `crypto.test.ts` — `encryptMessage`/`decryptMessage` round-trips
- `webhook.test.ts` — Express server lifecycle, Zod payload validation, sync/async handlers
- `registry.test.ts` — Registry client with `vi.mock` for `fetch`; `canonicalJson`
- `payment.test.ts` — `X402PaymentProcessor` ETH address derivation
- `message.test.ts` — `AgentMessage` serialization, `prompt` alias
- `entity-card.test.ts` — `buildEntityCard`, `signEntityCard`, signature verification
- `entity-card-loader.test.ts` — `loadEntityCard`, `computeCardHash`, `buildRuntimeCard`
- `config-manager.test.ts` — `ConfigManager` read/write
- `search.test.ts` — `SearchAndDiscoveryManager` (mocked)
- `types.test.ts` — Zod schema edge cases

#### `examples/`

- `simple-service.ts/js` — Minimal `ZyndService` with `setHandler`
- `custom-agent.ts/js` — `ZyndAIAgent` with `setCustomAgent`
- `x402-payment.ts/js` — x402 micropayment flow
- `test-langchain/` — Standalone runnable LangChain.js agent project

#### `scripts/`

- `verify-registry.mjs` — Sanity check: every framework in `frameworks.ts` has a matching `.tpl` and no orphans exist

---

### Key Flows

**Init / Auth:**
1. `zynd init` → `generateKeypair()` → `~/.zynd/developer.json`
2. `zynd auth login` → open browser → local HTTP callback → AES-GCM decrypt keypair from registry response

**Scaffold:**
1. `zynd agent init` → `prompts.ts` (lang + framework + name) → `scaffoldIdentity` (HD-derive next keypair) → read `.tpl` from `dist/templates/{ts|py}/` → write project files

**Run:**
1. Spawn `npx tsx agent.ts` or `python3 agent.py`
2. Poll `/health`
3. Upsert on registry: `getEntity` → if found, `updateEntity`; if not, `registerEntity`; if register returns 409, fall back to `updateEntity`
4. Heartbeat in `ZyndBase.start()`

**Webhook / invoke:**
1. `POST /webhook/sync` → Zod validate → fire `MessageHandler` → `invoke()` → framework dispatch → `setResponse()` → `200`

**Heartbeat:**
- `ZyndBase` opens WS to `registryUrl/v1/entities/{id}/ws`; sends signed second-precision timestamp (`YYYY-MM-DDTHH:MM:SSZ`) every 30s; reconnects after 5s

---

### Notes / Gotchas

- **CLI is fully bundled** (`noExternal: [/.*/]`) — single CJS file
- **Templates copied at build time**: `tsup.config.ts` `onSuccess` copies `.tpl` files to `dist/templates/`; stale after a partial build
- **Python templates in TS SDK**: `src/templates/py/*.tpl` are copies of Python SDK templates with no sync mechanism — can drift
- **ETH address from Ed25519 key**: `SHA-256(privateKeyBytes)` → deterministic EVM account; changing keypair changes payment address
- **`prompt` alias**: `AgentMessage.toDict()` emits both `content` and `prompt` keys
- **HKDF info string**: `"agdns:encryption:v1"` — must match Python `utils.py` exactly
- **Registry URL default**: `"https://dns01.zynd.ai"` in `types.ts:19` and `cli/config.ts:5`
- **HD derivation prefix mismatch**: TS `identity.ts` uses `"zns:agent:"`; Python `ed25519_identity.py` uses `"agdns:agent:"` — **cross-SDK HD derivation produces different keypairs**

---

## Repo 2 — `agentdns`

**Status: NOT FOUND** at `/Users/swapnilshinde/Desktop/p3ai/agentdns`.

Registry HTTP API implied by both SDK clients (`src/registry.ts`, `zyndai_agent/dns_registry.py`):
- `POST /v1/entities/register`
- `GET /v1/entities/{id}`
- `PUT /v1/entities/{id}`
- `DELETE /v1/entities/{id}`
- `POST /v1/search`
- `GET /v1/resolve/{developer}/{entity}`
- `GET /v1/entities/{id}/ws` (WebSocket heartbeat)
- `GET /v1/entities/{id}/card`

`zyndai_agent/entity_card.py` docstring references `agent-dns/internal/models/agent_card.go` — confirms it is a Go service.

---

## Repo 3 — `zyndai-agent` (Python SDK)

**Package name:** `zyndai-agent` (PyPI) v0.3.6
**CLI bin:** `zynd` → `zynd_cli.main:main`
**Purpose:** Python SDK mirroring the TS SDK. Same concepts: `ZyndBase`, `ZyndAIAgent`, `ZyndService`, Ed25519 identity, DNS registry client, Entity Cards, WebSocket heartbeat, Flask webhook server, x402 micropayments. Frameworks: LangChain, LangGraph, CrewAI, PydanticAI, custom.

**Entrypoints**
- Library: `zyndai_agent/__init__.py`
- CLI: `zynd_cli/main.py:main`; also `zynd_cli/__main__.py`

**Optional extras**

| Extra | Dep | Purpose |
|---|---|---|
| `[ngrok]` | pyngrok | ngrok tunnel |
| `[mqtt]` | paho-mqtt | Legacy MQTT transport |
| `[heartbeat]` | websockets>=14.0 | WebSocket heartbeat (required for `active` status) |
| `[dev]` | pytest | Tests |

---

### Directory Tree

#### `zyndai_agent/`

- `__init__.py` — Public API barrel; `__all__` exports all classes + `DNSRegistryClient` namespace
- `base.py` — `ZyndBase` + `ZyndBaseConfig` (Pydantic `BaseModel`): keypair resolution, webhook start, heartbeat thread, card signing, registry upsert on `start()`; Rich console helpers (`_log_ok`, `_log_warn`, `_log_err`, `_log_heartbeat`)
- `agent.py` — `ZyndAIAgent extends ZyndBase` + `AgentConfig`: `AgentFramework` str enum; `set_langchain_agent`, `set_langgraph_agent`, `set_crewai_agent`, `set_pydantic_ai_agent`, `set_custom_agent`; `invoke()` dispatcher
- `service.py` — `ZyndService extends ZyndBase` + `ServiceConfig`: `set_handler(fn)`; `invoke(input_text)`
- `ed25519_identity.py` — `Ed25519Keypair` (wraps `cryptography`), `generate_keypair`, `keypair_from_private_bytes`, `load_keypair`, `load_keypair_with_metadata`, `save_keypair`, `sign`, `verify`, `generate_entity_id`, `generate_developer_id`, `derive_agent_keypair` (SHA-512, prefix `"agdns:agent:"`), `create_derivation_proof`, `check_entity_name_available`
- `identity.py` — `IdentityManager`: `verify_entity_identity(public_key_b64, message, signature)`; simplified from Polygon ID
- `dns_registry.py` — Module-level functions: `register_entity`, `get_entity`, `update_entity`, `delete_entity`, `search_entities`, `resolve_entity`, `get_entity_card`, `check_entity_name_available`; raw `requests` HTTP calls; signs requests
- `webhook_communication.py` — `WebhookCommunicationManager`: Flask server with `/webhook`, `/webhook/sync`, `/health`, `/.well-known/agent.json`; x402 `PaymentMiddleware` on `/webhook/sync`; threaded async message queue
- `communication.py` — `AgentCommunicationManager` + `MQTTMessage`: legacy MQTT transport (paho-mqtt optional); uses `utils.py` encrypt/decrypt
- `message.py` — `AgentMessage`: `content`, `sender_id`, `receiver_id`, `message_type`, `message_id`, `conversation_id`, `metadata`, `timestamp`; `to_dict()` emits `prompt` alias; `from_dict()`, `to_json()`, `from_json()`
- `payload.py` — `AgentPayload(BaseModel)`: `extra="allow"`, `prompt` aliases to `content`; `Attachment` model (base64 data); subclassable; JSON Schema advertised in Entity Card
- `search.py` — `SearchAndDiscoveryManager` + `AgentSearchResponse(TypedDict)`: wraps `dns_registry.search_entities`
- `payment.py` — `X402PaymentProcessor`: `Account.from_key(sha256(pk_bytes).hex())`; `x402ClientSync`; `x402_http_adapter` for `requests.Session`
- `entity_card.py` — `build_endpoints`, `build_entity_card`, `sign_entity_card`; references `agent-dns/internal/models/agent_card.go`
- `entity_card_loader.py` — `load_entity_card`, `resolve_keypair`, `build_runtime_card`, `compute_card_hash`, `resolve_card_from_config`, `load_derivation_metadata`
- `config_manager.py` — `ConfigManager`: reads/writes `.agent/config.json`; keypair derivation + registry calls
- `utils.py` — `encrypt_message`/`decrypt_message` (X25519-AES256-GCM, HKDF `"agdns:encryption:v1"`), `private_key_from_base64`, `derive_private_key_from_seed` (legacy EC key from seed phrase — unclear current usage)

#### `zynd_cli/`

- `main.py` — argparse entry; `--registry` global flag; delegates to subcommand `func`
- `__main__.py` — `python -m zynd_cli` support
- `config.py` — `zynd_dir`, `ensure_zynd_dir`, `developer_key_path`, `agents_dir`, `services_dir`, `get_registry_url`, `save_config`; layout mirrors TS `cli/config.ts`
- `tui.py` — Rich + raw termios TUI; `pick_option`, `prompt_text`; accent `"#8B5CF6"`

**`zynd_cli/commands/`**

- `_entity_base.py` — `EntityRunner` abstract base + `slugify_name`: load `.env`, resolve keypair, `subprocess.Popen`, poll `/health`, `register_entity`/`update_entity`, block
- `agent_cmd.py` — `AgentRunner(EntityRunner)`: `zynd agent init` (TUI framework picker) + `zynd agent run`; name availability check
- `service_cmd.py` — `ServiceRunner(EntityRunner)`: `zynd service init` + `zynd service run`
- `auth.py` — `zynd auth login`: browser OAuth-style, local HTTP callback, AES-GCM decrypt from registry
- `init_cmd.py` — `zynd init`: generate developer keypair
- `keys.py` — `zynd keys list/create/derive/show`
- `register.py` — `zynd register`: one-shot registration
- `deregister.py` — `zynd deregister ENTITY_ID`
- `search.py` — `zynd search` with filters
- `resolve.py` — `zynd resolve ENTITY_ID --json`
- `card.py` — `zynd card show [ENTITY_ID | --file PATH] --json`
- `status.py` — `zynd status`
- `info.py` — `zynd info`

**`zynd_cli/templates/`**

- `__init__.py` — `FRAMEWORKS` dict + `FRAMEWORK_ORDER`; install commands and env keys per framework
- `langchain.py.tpl`, `langgraph.py.tpl`, `crewai.py.tpl`, `pydantic_ai.py.tpl`, `custom.py.tpl` — Python agent templates per framework
- `service.py.tpl`, `payload.py.tpl`

#### `tests/`

All tests use **pytest**.

- `test_ed25519_identity.py` — keygen, sign/verify, entity ID derivation, HD derivation, derivation proof
- `test_agent_card.py` — `build_entity_card`, `sign_entity_card`, verification
- `test_agent_card_loader.py` — `load_entity_card`, `compute_card_hash`, `build_runtime_card`
- `test_agent_config.py` — `AgentConfig`/`ServiceConfig` Pydantic validation
- `test_config_manager.py` — `ConfigManager` read/write
- `test_dns_registry.py` — registry client (mocked HTTP)
- `test_heartbeat.py` — WebSocket heartbeat thread
- `test_message.py` — `AgentMessage` serialization + `prompt` alias
- `test_payload_format.py` — `AgentPayload`/`Attachment` validation
- `test_search.py` — `SearchAndDiscoveryManager` (mocked)
- `test_utils.py` — encrypt/decrypt
- `test_webhook_communication.py` — Flask test client: sync/async, x402
- `test_cli_commands.py` — `zynd init`, `zynd agent init`, `zynd service init`, `zynd keys`
- `test_multiframework_agents.py` — `ZyndAIAgent.invoke()` across all frameworks (mock executors)

#### `examples/`

**`examples/http/`**:
- `stock_langchain.py`, `stock_langgraph.py`, `stock_crewai.py`, `stock_pydantic_ai.py` — Framework-specific stock-price agents
- `user_agent.py` — Orchestrator that discovers and delegates to specialist agents
- `image_prompt_agent.py`, `text_transform_service.py`, `weather_service.py` — Utility agents/services
- `instagram-scraper-service/` — `ZyndService` with `service.config.json`
- `job-scrapper/` — LinkedIn job scraper service
- `sahil02-persona/`, `swapnil-persona/`, `swapnil-test/` — Persona agents with `agent.config.json`

**`examples/mqtt/`** (legacy): `agent1.py`, `agent2.py` — MQTT transport (requires `[mqtt]`)

**`examples/`**: `x402_impl.py` — x402 payment demonstration

---

### Key Flows

**EntityRunner run flow (`_entity_base.py`):**
1. `load_dotenv(cwd/.env)`
2. Resolve keypair from env vars
3. `subprocess.Popen(["python3", "agent.py"])`
4. Poll `GET /health`
5. `register_entity` or `update_entity` with `developer_proof`
6. Block; heartbeat inside user script via `ZyndBase`

**Heartbeat (requires `[heartbeat]` extra):**
- Thread connects WS to `{registry_url}/v1/entities/{id}/ws`
- Sends `{"timestamp":"…","signature":"ed25519:<b64>"}` every 30s; reconnects on failure

**x402 (receive):**
- Flask `PaymentMiddleware` on `/webhook/sync` when pricing set
- Payment address = `Account.from_key(sha256(private_key_bytes).hex())`

---

### Notes / Gotchas

- **`[heartbeat]` is optional**: without it no heartbeat → entity stays `inactive` on registry
- **MQTT is legacy**: `communication.py` / `[mqtt]` extra; current transport is HTTP webhooks
- **`prompt` alias**: both `AgentPayload` and `AgentMessage` accept `content` or `prompt`
- **`utils.py` mixed concerns**: `encrypt_message`/`decrypt_message` (active); `derive_private_key_from_seed` (legacy EC, unclear if still used)
- **`repowise.db`** at repo root: SQLite artifact from a code-search tool, not part of the SDK

---

## Cross-Repo Relationships

| Concept | TS SDK | Python SDK | Registry |
|---|---|---|---|
| Base class | `src/base.ts` `ZyndBase` | `zyndai_agent/base.py` `ZyndBase` | n/a |
| Agent | `src/agent.ts` `ZyndAIAgent` | `zyndai_agent/agent.py` `ZyndAIAgent` | n/a |
| Service | `src/service.ts` `ZyndService` | `zyndai_agent/service.py` `ZyndService` | n/a |
| Identity | `src/identity.ts` | `zyndai_agent/ed25519_identity.py` | Go Ed25519 |
| Registry client | `src/registry.ts` | `zyndai_agent/dns_registry.py` | `dns01.zynd.ai` |
| Entity Card | `src/entity-card.ts` | `zyndai_agent/entity_card.py` | `agent-dns/internal/models/agent_card.go` |
| Webhook server | Express (`src/webhook.ts`) | Flask (`zyndai_agent/webhook_communication.py`) | n/a |
| Payment | `src/payment.ts` (viem) | `zyndai_agent/payment.py` (eth-account) | x402 on Base L2 |
| Encryption | `src/crypto.ts` (@noble) | `zyndai_agent/utils.py` (cryptography) | HKDF `"agdns:encryption:v1"` |
| CLI | `src/cli/index.ts` (Commander) | `zynd_cli/main.py` (argparse) | n/a |
| Templates | `src/templates/ts/` + `src/templates/py/` | `zynd_cli/templates/` | n/a |
| Config dir | `~/.zynd/` | `~/.zynd/` | shared |

**Wire compatibility:** Both SDKs use the same registry API, Entity Card schema, `AgentMessage` wire format, and HKDF encryption. A TS agent and a Python agent can discover and call each other.

**Template duplication (drift risk):** `src/templates/py/*.tpl` in the TS SDK are copies of `zynd_cli/templates/*.tpl` in the Python SDK — no sync mechanism exists.

**HD derivation prefix mismatch (active bug):** TS `identity.ts` uses prefix `"zns:agent:"`; Python `ed25519_identity.py` uses `"agdns:agent:"`. Same developer seed + same index → **different keypairs** in each SDK. Cross-SDK HD key derivation is broken.
