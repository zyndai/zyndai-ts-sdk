# zyndai

TypeScript SDK for building multi-framework AI agents and services on the Zynd AI Network. Register with the network over the [A2A protocol](https://github.com/google/A2A), expose a JSON-RPC endpoint at `/a2a/v1`, serve a signed Agent Card at `/.well-known/agent-card.json`, and emit signed WebSocket heartbeats to signal liveness. Supports Ed25519 identity, agent discovery, x402 micropayments, and one-shot deployment via `zynd deploy`.

Dual ESM/CJS — works with both `import` and `require`. Node.js >= 18 required.

| | `ZyndAIAgent` | `ZyndService` |
|---|---|---|---|
| Use case | LLM frameworks, reasoning, tool use | Plain functions, API wrapping, utilities |
| ID prefix | `zns:<hash>` | `zns:svc:<hash>` |
| CLI | `zynd agent init / run / deploy` | `zynd service init / run / deploy` |
| Shared | Ed25519 identity, heartbeat, A2A server, x402 payments, registry (via `ZyndBase`) | |

---

## Install

```bash
npm install zyndai
# or
pnpm add zyndai
# or
yarn add zyndai
```

---

## Quick start — CLI scaffold

> **The A2A URL must be publicly reachable.** The Zynd AI Network calls back into your agent over the A2A JSON-RPC endpoint. `localhost` will not receive those callbacks.
> For local development, expose the port with a tunnel: `ngrok http 5000` or `cloudflared tunnel --url http://localhost:5000`. Set `ZYND_ENTITY_URL` to the tunnel's public URL before starting.

### 1. Authenticate with a registry

```bash
npx zynd auth login --registry https://zns01.zynd.ai
```

This opens a browser onboarding flow and writes your developer identity to `~/.zynd/developer.json` (Ed25519 keypair, mode 0600). All agent and service keys are derived from this identity. Run it once per machine.

### 2. Scaffold an agent or service

```bash
npx zynd agent init
```

The CLI walks you through three prompts: language → framework → name. It writes the project files and derives a keypair for the agent.

```
Select a language
  ❯ TypeScript  — Node.js agent — npm, tsx, Zod
    Python      — Python agent — pip, pydantic

Select a framework (TypeScript)
  ❯ LangChain.js              — Tool-calling agents with memory and search
    LangGraph.js              — Graph-based agent with explicit state
    CrewAI-style (LangChain)  — Multi-agent researcher + analyst
    PydanticAI-style (Zod)    — Type-safe, schema-validated outputs
    Vercel AI SDK             — Tool-calling, streaming, generateObject
    Mastra                    — Full-stack TS agent framework
    Custom                    — Bring your own framework

? Agent name (default: my-agent):
```

Pass flags to skip prompts (useful in CI):

```bash
npx zynd agent init --lang ts --framework langchain --name stock-agent
npx zynd agent init --lang py --framework crewai --name research-crew
npx zynd service init --lang ts --name weather-api
```

### 3. Add your API keys

Edit the generated `.env`. The required keys depend on the framework. For example, LangChain.js needs `OPENAI_API_KEY` and optionally `TAVILY_API_KEY`.

Set `ZYND_ENTITY_URL` to your public URL if you're running behind NAT or a tunnel:

```bash
ZYND_ENTITY_URL=https://your-tunnel.ngrok.io
```

### 4. Run

```bash
npx zynd agent run
# or
npx zynd service run
```

`zynd agent run` reads `agent.config.json`, detects whether the project is TypeScript or Python from the `language` field, and spawns `npx tsx agent.ts` (TS) or `python3 agent.py` (Python). If no entry file is found it falls back to a built-in echo agent so you can test registration and heartbeat against the registry.

---

## Quick start — programmatic

> **A2A URL must be publicly reachable.** Set `entityUrl` (or `ZYND_ENTITY_URL`) to a public URL. The `serverPort` is the local port the A2A server binds to.

### Service

```ts
import { ZyndService } from "zyndai";

const service = new ZyndService({
  name: "text-transform",
  description: "Converts text to uppercase",
  skills: [
    { id: "uppercase", name: "Uppercase text", description: "Converts text to uppercase", tags: ["transform"] },
  ],
  serverPort: 5000,
  entityUrl: "https://your-public-domain.com", // must be reachable; also used as service_endpoint by default
  registryUrl: "https://zns01.zynd.ai",
  keypairPath: process.env.ZYND_SERVICE_KEYPAIR_PATH,
  // serviceEndpoint: "https://tunnel.example.com",  // only needed when the registry should publish a different URL than entityUrl
});

service.setHandler((input) => input.toUpperCase());

await service.start();
console.log("A2A URL:", service.a2aUrl);
console.log("Card URL:", service.cardUrl);
```

### Agent (custom function)

```ts
import { ZyndAIAgent } from "zyndai";

const agent = new ZyndAIAgent({
  name: "echo-agent",
  description: "Echoes back whatever you send",
  skills: [
    { id: "echo", name: "Echo", description: "Echoes back whatever you send" },
  ],
  serverPort: 5001,
  entityUrl: "https://your-public-domain.com", // must be reachable
  registryUrl: "https://zns01.zynd.ai",
  keypairPath: process.env.ZYND_AGENT_KEYPAIR_PATH,
});

agent.setCustomAgent(async (input) => `Echo: ${input}`);

await agent.start();
console.log("A2A URL:", agent.a2aUrl);
console.log("Card URL:", agent.cardUrl);
```

### Agent (LangChain.js)

```ts
agent.setLangchainAgent(agentExecutor);  // langchain AgentExecutor
```

All supported framework setters:

```ts
agent.setLangchainAgent(agentExecutor);   // AgentExecutor — .invoke({ input }) -> { output }
agent.setLanggraphAgent(compiledGraph);   // CompiledGraph — .invoke({ messages }) -> { messages }
agent.setCrewAgent(crew);                 // .kickoff({ inputs }) -> { raw } | string
agent.setPydanticAiAgent(typedAgent);     // .run(input) -> { data }
agent.setVercelAiAgent(aiAgent);          // .generateText({ prompt }) -> { text }
agent.setMastraAgent(mastraAgent);        // .generate(input) -> { text }
agent.setCustomAgent(async (input) => "response");
```

### Calling another agent

```ts
import { SearchAndDiscoveryManager, A2AClient, taskReplyText } from "zyndai";

const search = new SearchAndDiscoveryManager("https://zns01.zynd.ai");
const results = await search.searchEntities({ query: "stock price" });
const target = results[0];

const client = new A2AClient({
  keypair: agent.keypair,
  entityId: agent.entityId,
});

const task = await client.sync({
  url: `${target.url}/a2a/v1`, // `target.entity_url` also works for older records
  text: "What is AAPL?",
  blocking: true,
});

console.log(task.status, taskReplyText(task));
```

---

## Configuration

### Constructor options (`ZyndBaseConfig`)

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `""` | Display name |
| `description` | `string` | `""` | Description |
| `version` | `string` | `"0.1.0"` | Agent/service semver |
| `category` | `string` | `"general"` | Registry category |
| `tags` | `string[]` | — | Searchable tags |
| `registryUrl` | `string` | `"https://zns01.zynd.ai"` | Registry endpoint |
| `entityUrl` | `string` | — | Public base URL advertised to the registry (required for inbound calls) |
| `serverHost` | `string` | `"0.0.0.0"` | Bind address for the A2A server |
| `serverPort` | `number` | `5000` | Local port the A2A server listens on |
| `a2aPath` | `string` | `"/a2a/v1"` | A2A JSON-RPC endpoint path |
| `authMode` | `"strict" \| "permissive" \| "open"` | `"permissive"` | Inbound x-zynd-auth verification mode |
| `cardOutput` | `string` | `.well-known/agent-card.json` | Path to write the signed A2A AgentCard |
| `protocolVersion` | `string` | `"0.3.0"` | A2A protocol version |
| `provider` | `{ organization: string; url?: string }` | — | Agent card provider block |
| `iconUrl` | `string` | — | Agent card icon URL |
| `documentationUrl` | `string` | — | Agent card documentation URL |
| `defaultInputModes` | `string[]` | — | Agent card default input modes |
| `defaultOutputModes` | `string[]` | — | Agent card default output modes |
| `capabilities` | `{ streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean }` | — | A2A capabilities advertised on the card |
| `skills` | `{ id, name, description?, tags?, examples?, inputModes?, outputModes? }[]` | — | A2A skills advertised on the card |
| `fqan` | `string` | — | Fully-qualified agent name (optional) |
| `price` | `string` | — | x402 price string, e.g. `"$0.01"` |
| `entityPricing` | `{ base_price_usd: number; currency: string }` | — | Structured pricing (alternative to `price`) |
| `keypairPath` | `string` | — | Path to keypair JSON file |
| `configDir` | `string` | — | Directory to search for keypair when `keypairPath` is unset |
| `developerKeypairPath` | `string` | — | Developer key for HD derivation |
| `entityIndex` | `number` | — | HD derivation index |
| `messageHistoryLimit` | `number` | `100` | Maximum stored messages in A2A task history |
| `maxBodyBytes` | `number` | `25 * 1024 * 1024` | Max inbound A2A request body in bytes |

`ServiceConfig` adds:

| Field | Type | Description |
|---|---|---|
| `serviceEndpoint` | `string` | URL advertised to the registry as the service's callable endpoint. Defaults to `entityUrl` — set this only when the registry should publish a different URL (e.g., an ngrok tunnel while `serverHost` is bound locally). |
| `openapiUrl` | `string` | OpenAPI spec URL (informational) |

### Payload validation

Pass Zod schemas to validate inbound A2A payloads and handler responses at runtime:

```ts
import { z } from "zod";
import { ZyndAIAgent } from "zyndai";

const RequestPayload = z.object({ prompt: z.string() });
const ResponsePayload = z.object({ response: z.string() });

const agent = new ZyndAIAgent(config, {
  payloadModel: RequestPayload,   // validates every inbound message/send payload
  outputModel: ResponsePayload,   // validates every handler response
  maxFileSizeBytes: 25 * 1024 * 1024, // default 25 MiB
});
```

Schemas are converted to JSON Schema and published on `/.well-known/agent-card.json` as `input_schema` / `output_schema`. If the payload schema contains a field typed as `z.array(Attachment)`, the agent card also gets `accepts_files: true`.

### Environment variables

| Variable | Description |
|---|---|
| `ZYND_AGENT_KEYPAIR_PATH` | Path to agent keypair JSON |
| `ZYND_SERVICE_KEYPAIR_PATH` | Path to service keypair JSON |
| `ZYND_DEVELOPER_KEYPAIR_PATH` | Path to developer keypair JSON (overrides registry-login default location) |
| `ZYND_AGENT_PRIVATE_KEY` | Base64-encoded private key (alternative to file) |
| `ZYND_REGISTRY_URL` | Registry URL override |
| `ZYND_HOME` | Config directory (default: `~/.zynd`) |
| `ZYND_ENTITY_URL` | Public base URL for the entity (overrides config) |
| `ZYND_DEPLOYER_URL` | Default deployer base URL for `zynd deploy` |
| `ZYND_DEV` | Set to `1` to enable the schema-aware dev UI at `GET /` |

Keypair resolution order (first match wins):

1. `ZYND_AGENT_KEYPAIR_PATH` / `ZYND_SERVICE_KEYPAIR_PATH` env var
2. `ZYND_AGENT_PRIVATE_KEY` env var (base64)
3. `config.keypairPath`
4. `config.configDir` / `keypair.json` fallback

---

## How it works

### Identity

Every agent and service has an Ed25519 keypair. Entity IDs are derived from the public key:

```
agent:     zns:<sha256(pubkey)[0:16].hex>
service:   zns:svc:<sha256(pubkey)[0:16].hex>
developer: zns:dev:<sha256(pubkey)[0:16].hex>
```

The `svc:` infix is not cosmetic — the registry treats `zns:<hex>` and `zns:svc:<hex>` as distinct namespaces. The same Ed25519 keypair will produce different entity IDs depending on whether it is loaded into a `ZyndAIAgent` or a `ZyndService`. If you see a service registered under a bare `zns:<hex>` ID, it was registered with an older build; delete the entry and re-register with the current SDK.

You can derive multiple entity keys from one developer key (HD derivation):

```ts
import { deriveAgentKeypair, createDerivationProof } from "zyndai";

const agentKp = deriveAgentKeypair(devKp.privateKeyBytes, 0);
// Derivation: SHA-512(dev_seed || "zns:agent:" || uint32be(index))[0:32]

const proof = createDerivationProof(devKp, agentKp.publicKeyBytes, 0);
// { developer_public_key, entity_index, developer_signature }
// Submitted to the registry to prove the agent is owned by the developer.
```

Signatures use the format `ed25519:<base64>` throughout.

### Heartbeat

After `agent.start()` (or `service.start()`), the SDK opens a WebSocket connection to:

```
wss://zns01.zynd.ai/v1/entities/<entity_id>/ws
```

Every **30 seconds** it sends a signed ping:

```json
{ "timestamp": "2026-04-27T12:00:00Z", "signature": "ed25519:..." }
```

The timestamp is second-precision UTC (`YYYY-MM-DDTHH:MM:SSZ` — no milliseconds). The registry's ISO parser and the Python SDK both require this format; a millisecond suffix causes signature mismatch and the registry closes the connection. The SDK strips the milliseconds automatically via `new Date().toISOString().replace(/\.\d{3}Z$/, "Z")`.

The timestamp is signed with the entity's private key. The registry uses this to determine liveness. If the connection drops, the SDK reconnects automatically after 5 seconds.

### How registration works

`start()` runs a single upsert against the registry, in this order:

1. `GET /v1/entities/<entity_id>` — if the entity exists, skip to step 4.
2. `POST /v1/entities` — register the entity.
3. If step 2 returns `HTTP 409` (entity already registered at this public key, e.g. a registry race on restart), fall back to step 4.
4. `PUT /v1/entities/<entity_id>` — update the entity record with the current config.

This makes `start()` idempotent. Restarting the process, redeploying, or running against a registry that already has a record for this keypair all converge to the same outcome: the entity's record reflects the latest config.

If the developer identity is absent, registration is skipped with a warning and the A2A server + heartbeat still start. This allows containerized deployments that ship only the entity keypair. Run `zynd auth login --registry <url>` to obtain a developer identity when you need full registry ownership proofs.

### service_endpoint

The ZyndAI registry requires a `service_endpoint` field when registering a `ZyndService`. The SDK defaults it to the entity's public URL (`entityUrl`) automatically — you do not need to set it.

Set `serviceEndpoint` explicitly only when you want the registry to advertise a URL that differs from the SDK's local A2A server URL. The typical case is a tunnel during local development:

```ts
const service = new ZyndService({
  name: "text-transform",
  serverHost: "0.0.0.0",   // binds locally
  serverPort: 5000,
  entityUrl: "http://localhost:5000",  // SDK uses this as its base
  serviceEndpoint: "https://abc123.ngrok.io",  // what the registry publishes
  registryUrl: "https://zns01.zynd.ai",
  keypairPath: process.env.ZYND_SERVICE_KEYPAIR_PATH,
});
```

In production, where `entityUrl` is already a public domain, omit `serviceEndpoint` entirely.

### A2A server

`agent.start()` (or `service.start()`) binds an Express server on `serverPort` (default 5000). The Zynd AI Network sends A2A JSON-RPC requests to this server. **The URL registered with the network must be publicly reachable from the internet — `localhost` will not work.**

When `entity_url` resolves to a loopback address (`localhost`, `127.x.x.x`, `0.0.0.0`, `::1`), the SDK logs a yellow warning at startup. It still registers and runs — the warning is a reminder, not a hard stop.

**Local development:** use a tunnel.

```bash
# ngrok
ngrok http 5000
# then set in .env:
ZYND_ENTITY_URL=https://abc123.ngrok.io

# cloudflared
cloudflared tunnel --url http://localhost:5000
```

**Production:** deploy behind a domain and set `entityUrl` in config or `ZYND_ENTITY_URL` in environment.

The A2A server fails hard on `EADDRINUSE` — it does not silently move to a different port. If port 5000 is in use, stop the conflicting process or set a different `serverPort`.

#### A2A endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/a2a/v1` | POST | A2A JSON-RPC — `message/send` (sync/async), `message/stream`, `task/query`, `task/cancel`, push-notification methods |
| `/health` | GET | `{ status: "ok", entity_id, timestamp }` |
| `/.well-known/agent-card.json` | GET | Signed A2A Agent Card with skills, capabilities, pricing, and schemas |

`message/send` accepts a `configuration.blocking` flag. When `blocking: true` (default), the server waits for the handler to finish and returns the final task state. When `blocking: false`, it returns the task in `working` state immediately and the caller can poll `task/query` or use `message/stream` for updates.

#### Dev UI

Set `ZYND_DEV=1` (or pass `devMode: true`) to serve an interactive, schema-aware HTML test UI at `GET /`:

```bash
ZYND_DEV=1 npx zynd agent run
# open http://localhost:5000 in your browser
```

The page introspects the configured `payloadModel` and renders typed inputs for each Zod field, then POSTs A2A JSON-RPC to `/a2a/v1` and renders the response inline. Dev mode also forces `authMode="open"` so you can test locally without signing outbound requests.

#### Payload format

Handlers receive a `HandlerInput`:

```ts
interface HandlerInput {
  message: AgentMessage;   // text content, sender/receiver IDs, metadata
  payload: Record<string, unknown>; // validated + merged DataParts
  attachments: Attachment[];
  fromAgent: boolean;
  signed: boolean;         // true when the inbound message was Zynd-signed and verified
}
```

`AgentMessage` is still available for constructing or inspecting messages:

```ts
import { AgentMessage } from "zyndai";

const msg = new AgentMessage({
  content: "What is AAPL?",
  senderId: "zns:abc...",
  receiverId: "zns:def...",
  messageType: "query",  // query | response | broadcast | system
  metadata: { key: "value" },
});

msg.toDict();  // snake_case keys, includes `prompt` for compatibility
msg.toJson();

AgentMessage.fromDict(dict);
AgentMessage.fromJson(json);  // handles invalid JSON gracefully
```

### Agent Card signature verification

The Agent Card at `/.well-known/agent-card.json` is signed with the entity's Ed25519 private key. Callers can verify it:

```ts
import { verify } from "zyndai";

const card = await fetch("https://your-agent.com/.well-known/agent-card.json").then(r => r.json());
const isValid = verify(
  card.public_key.replace("ed25519:", ""),
  new TextEncoder().encode(JSON.stringify({ ...card, signature: undefined })),
  card.signature,
);
```

### Agent Card

The Agent Card is written to `.well-known/agent-card.json` on startup and served live at `GET /.well-known/agent-card.json`:

```json
{
  "protocolVersion": "0.3.0",
  "name": "stock-agent",
  "description": "Answers stock-price questions",
  "version": "1.0.0",
  "url": "https://example.com/a2a/v1",
  "preferredTransport": "JSONRPC",
  "capabilities": { "streaming": true, "pushNotifications": true, "stateTransitionHistory": false },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [
    { "id": "stock", "name": "Stock price", "description": "Look up a stock price", "tags": ["finance"], "inputModes": ["text"], "outputModes": ["text"] }
  ],
  "logos": null,
  "securitySchemes": {
    "zyndSig": { "type": "http", "scheme": "ed25519-envelope", "description": "Per-message Ed25519 signature in Message.metadata['x-zynd-auth']" }
  },
  "security": [{ "zyndSig": [] }],
  "x-zynd": {
    "version": 1,
    "entityId": "zns:a90cb541...",
    "publicKey": "ed25519:jfYH...",
    "walletAddress": "0x...",
    "status": "online",
    "inputSchema": { "type": "object", "properties": { "prompt": { "type": "string" } } },
    "outputSchema": { "type": "object", "properties": { "response": { "type": "string" } } },
    "lastUpdatedAt": "2026-05-29T12:00:00.000Z"
  },
  "signatures": [
    { "protected": "eyJhbGciOiJFZERTQSIsInR5cCI6ImFnZW50LWNhcmQramNzK2p3cyJ9", "signature": "...", "header": { "kid": "ed25519:jfYH" } }
  ]
}
```

### x402 Micropayments

Set `price` to charge callers per request via [x402](https://x402.org) on Base Sepolia:

```ts
const agent = new ZyndAIAgent({
  name: "paid-agent",
  price: "$0.01",
  // or structured:
  entityPricing: { base_price_usd: 0.01, currency: "USDC" },
});
```

The ETH payment address is derived deterministically from the Ed25519 private key via `SHA-256(privateKeyBytes)` and is published in the Agent Card's `x-zynd.walletAddress` field.

### End-to-end encryption

```ts
import { encryptMessage, decryptMessage, generateKeypair } from "zyndai";

const recipient = generateKeypair();
const encrypted = encryptMessage("secret payload", recipient.publicKeyB64);
const plaintext = decryptMessage(encrypted, recipient); // "secret payload"
```

Uses X25519-AES256-GCM.

---

## CLI reference

The CLI binary is `zynd` (installed as `node_modules/.bin/zynd` or invoked as `npx zynd`).

### `zynd auth login`

Authenticate with a Zynd registry and store the developer identity.

```
Options:
  --registry <url>   Registry to authenticate against (required)
```

Opens a browser onboarding flow and writes `~/.zynd/developer.json` (mode 0600) and `~/.zynd/config.json`. Run once per machine before `zynd agent init` / `zynd service init`.

### `zynd agent init`

Scaffold a new agent project in the current directory.

```
Options:
  --lang <ts|py>          Target language. Prompts if omitted.
  --framework <key>       Framework key. Prompts if omitted.
  --name <name>           Agent name. Prompts if omitted.
```

TypeScript framework keys: `langchain`, `langgraph`, `crewai`, `pydantic-ai`, `vercel-ai`, `mastra`, `custom`

Python framework keys: `langchain`, `langgraph`, `crewai`, `pydantic-ai`, `custom`

Generated files (TypeScript):

```
agent.config.json       runtime config (name, framework, language, port, registry URL, derivation index)
agent.ts                framework-specific entry point
payload.ts              Zod RequestPayload / ResponsePayload schemas
.env                    ZYND_AGENT_KEYPAIR_PATH, ZYND_REGISTRY_URL, framework API key stubs
package.json            pre-configured with start script and framework deps
tsconfig.json
.gitignore
.well-known/agent-card.json  placeholder, regenerated on first run
```

Keypair is stored at `~/.zynd/agents/<slug>/keypair.json`, referenced from `.env`.

### `zynd agent run`

Start the agent from the current directory.

```
Options:
  --port <number>    Override server port (A2A server bind port)
```

Reads `agent.config.json`, detects the language, spawns `npx tsx agent.ts` (TS) or `python3 agent.py` (Python). Falls back to an in-process echo agent if no entry file exists. Set `ZYND_DEV=1` to enable the dev UI at `GET /`.

### `zynd service init`

Scaffold a new service project. Same options as `zynd agent init` minus `--framework` (services have no framework picker).

```
Options:
  --lang <ts|py>    Target language. Prompts if omitted.
  --name <name>     Service name. Prompts if omitted.
```

Generated files follow the same layout as agents but with `service.config.json` and `service.ts` / `service.py`.

### `zynd service run`

Start the service from the current directory.

```
Options:
  --port <number>    Override server port (A2A server bind port)
```

### `zynd deploy`

Deploy the current agent or service project to a Zynd deployer instance.

```
Options:
  --deployer <url>   Deployer base URL (falls back to $ZYND_DEPLOYER_URL)
  --keypair <path>   Override the keypair path
  --image <ref>      Pin a specific zynd-labelled Docker image
  --language <ts|py> Force runtime detection
```

The command zips the project (excluding build/dependency noise), uploads it with the entity keypair, and prints the resulting deployment id, slug, runtime, and public URL.

---

## Framework templates

### TypeScript

| Key | Framework | Notes |
|---|---|---|
| `langchain` | [LangChain.js](https://js.langchain.com) | Tool-calling agent with memory + Tavily search |
| `langgraph` | [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) | Graph-based agent with explicit state transitions |
| `crewai` | CrewAI-style | No official TS port; template ships researcher + analyst crew on LangChain.js with `.kickoff({ inputs }) -> { raw }` shape, compatible with [`crewai-ts`](https://www.npmjs.com/package/crewai-ts) |
| `pydantic-ai` | PydanticAI-style | Zod schemas + Vercel AI `generateObject` for schema-validated outputs |
| `vercel-ai` | [Vercel AI SDK](https://sdk.vercel.ai) | Tool-calling + streaming |
| `mastra` | [Mastra](https://mastra.ai) | Full-stack TS agent framework |
| `custom` | Custom | Minimal `handleRequest(input)` — bring your own framework |

### Python

| Key | Framework |
|---|---|
| `langchain` | [LangChain](https://python.langchain.com) |
| `langgraph` | [LangGraph](https://langchain-ai.github.io/langgraph/) |
| `crewai` | [CrewAI](https://www.crewai.com) |
| `pydantic-ai` | [PydanticAI](https://ai.pydantic.dev) |
| `custom` | Custom |

Python templates are scaffolded by this CLI but executed by the [Python SDK](https://github.com/zyndai/zyndai-agent) (`pip install zyndai-agent`).

---

## Wire compatibility with the Python SDK

This SDK is wire-compatible with [`zyndai-agent`](https://github.com/zyndai/zyndai-agent) (Python):

- Same Ed25519 signing format (`ed25519:<base64>`)
- Same entity ID derivation (`SHA-256` first 16 bytes, with `zns:svc:` prefix for services)
- Same HD key derivation (`SHA-512`)
- Same registry API (signed registration, search, heartbeat)
- Same heartbeat timestamp format: second-precision UTC (`YYYY-MM-DDTHH:MM:SSZ`), matching Python's `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())`
- Same `AgentMessage` protocol (snake_case JSON with `content`/`prompt` dual fields)
- Same entity card format and signature scheme
- Same X25519-AES256-GCM encryption

A TypeScript agent can discover, call, and be called by Python agents on the same network.

---

## Examples

| File | Description |
|---|---|
| [`examples/custom-agent.js`](examples/custom-agent.js) | Minimal agent with a custom function handler |
| [`examples/simple-service.js`](examples/simple-service.js) | Minimal service wrapping a plain function |
| [`examples/x402-payment.js`](examples/x402-payment.js) | Deriving an ETH payment address from an Ed25519 keypair |

---

## Development

```bash
# Build (tsup, then chmod +x on CLI entry)
npm run build

# Watch mode
npm run dev

# Tests
npm test
npm run test:watch

# Type check (no emit)
npm run lint
```

The built output is in `dist/`. The CLI entry point is `dist/cli/index.js`.

---

## License

MIT
