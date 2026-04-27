# zyndai

TypeScript SDK for building agents and services on the ZyndAI Network. Register with the network, expose an HTTP webhook endpoint the network calls back into, and emit signed WebSocket heartbeats to signal liveness.

Dual ESM/CJS — works with both `import` and `require`. Node.js >= 18 required.

| | `ZyndAIAgent` | `ZyndService` |
|---|---|---|
| Use case | LLM frameworks, reasoning, tool use | Plain functions, API wrapping, utilities |
| ID prefix | `zns:<hash>` | `zns:svc:<hash>` |
| CLI | `zynd agent init / run` | `zynd service init / run` |
| Shared | Ed25519 identity, heartbeat, webhook server, x402 payments, registry (via `ZyndBase`) | |

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

> **The webhook URL must be publicly reachable.** The ZyndAI Network calls back into your agent over HTTP. `localhost` will not receive those callbacks.
> For local development, expose the port with a tunnel: `ngrok http 5000` or `cloudflared tunnel --url http://localhost:5000`. Set `ZYND_ENTITY_URL` to the tunnel's public URL before starting.

### 1. Create your developer identity

```bash
npx zynd init
```

This generates `~/.zynd/developer.json` (Ed25519 keypair, mode 0600). All agent and service keys are derived from this key. Run it once per machine.

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

> **Webhook URL must be publicly reachable.** Set `entityUrl` (or `ZYND_ENTITY_URL`) to a public URL. The `webhookPort` is the local port the Express server binds to.

### Service

```ts
import { ZyndService } from "zyndai";

const service = new ZyndService({
  name: "text-transform",
  description: "Converts text to uppercase",
  capabilities: { text: ["transform"] },
  webhookPort: 5000,
  entityUrl: "https://your-public-domain.com", // must be reachable
  registryUrl: "https://dns01.zynd.ai",
  keypairPath: process.env.ZYND_SERVICE_KEYPAIR_PATH,
});

service.setHandler((input) => input.toUpperCase());

await service.start();
console.log("Webhook:", service.webhookUrl);
```

### Agent (custom function)

```ts
import { ZyndAIAgent, AgentMessage } from "zyndai";

const agent = new ZyndAIAgent({
  name: "echo-agent",
  description: "Echoes back whatever you send",
  capabilities: { text: ["echo"] },
  webhookPort: 5001,
  entityUrl: "https://your-public-domain.com", // must be reachable
  registryUrl: "https://dns01.zynd.ai",
  keypairPath: process.env.ZYND_AGENT_KEYPAIR_PATH,
});

agent.setCustomAgent(async (input) => `Echo: ${input}`);

agent.webhook.addMessageHandler(async (msg: AgentMessage) => {
  const result = await agent.invoke(msg.content);
  agent.webhook.setResponse(msg.messageId, result);
});

await agent.start();
console.log("Webhook:", agent.webhookUrl);
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
import { SearchAndDiscoveryManager } from "zyndai";

const search = new SearchAndDiscoveryManager("https://dns01.zynd.ai");
const results = await search.searchEntities({ query: "stock price" });
const target = results[0];

const invokeUrl = `${target.entity_url}/webhook/sync`;
const resp = await fetch(invokeUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "What is AAPL?", sender_id: agent.entityId }),
});
const data = await resp.json();
console.log(data.response);
```

---

## Configuration

### Constructor options (`ZyndBaseConfig`)

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `""` | Display name |
| `description` | `string` | `""` | Description |
| `capabilities` | `Record<string, unknown>` | — | Structured capabilities advertised on the entity card |
| `category` | `string` | `"general"` | Registry category |
| `tags` | `string[]` | — | Searchable tags |
| `summary` | `string` | — | Short description |
| `webhookHost` | `string` | `"0.0.0.0"` | Bind address for the Express server |
| `webhookPort` | `number` | `5000` | Local port the webhook server listens on |
| `entityUrl` | `string` | — | Public base URL advertised to the registry (required for inbound calls) |
| `webhookUrl` | `string` | — | Override the full webhook URL if non-standard |
| `registryUrl` | `string` | `"https://dns01.zynd.ai"` | Registry endpoint |
| `price` | `string` | — | x402 price string, e.g. `"$0.01"` |
| `entityPricing` | `{ base_price_usd: number; currency: string }` | — | Structured pricing (alternative to `price`) |
| `keypairPath` | `string` | — | Path to keypair JSON file |
| `configDir` | `string` | — | Directory to search for keypair when `keypairPath` is unset |
| `developerKeypairPath` | `string` | — | Developer key for HD derivation |
| `entityIndex` | `number` | — | HD derivation index |
| `messageHistoryLimit` | `number` | `100` | Maximum stored messages in webhook history |
| `autoReconnect` | `boolean` | `true` | Reconnect heartbeat WebSocket on drop |

`ServiceConfig` adds:

| Field | Type | Description |
|---|---|---|
| `serviceEndpoint` | `string` | Service API endpoint (informational, advertised on entity card) |
| `openapiUrl` | `string` | OpenAPI spec URL (informational) |

### Payload validation

Pass Zod schemas to validate inbound and outbound payloads at runtime:

```ts
import { z } from "zod";
import { ZyndAIAgent } from "zyndai";

const RequestPayload = z.object({ prompt: z.string() });
const ResponsePayload = z.object({ response: z.string() });

const agent = new ZyndAIAgent(config, {
  payloadModel: RequestPayload,   // validates every POST to /webhook
  outputModel: ResponsePayload,   // validates every setResponse() call
  maxFileSizeBytes: 25 * 1024 * 1024, // default 25 MiB
});
```

Schemas are converted to JSON Schema and published on `/.well-known/agent.json` as `input_schema` / `output_schema`. If the payload schema contains a field typed as `z.array(Attachment)`, the entity card also gets `accepts_files: true`.

### Environment variables

| Variable | Description |
|---|---|
| `ZYND_AGENT_KEYPAIR_PATH` | Path to agent keypair JSON |
| `ZYND_SERVICE_KEYPAIR_PATH` | Path to service keypair JSON |
| `ZYND_DEVELOPER_KEYPAIR_PATH` | Path to developer keypair JSON (overrides `~/.zynd/developer.json`) |
| `ZYND_AGENT_PRIVATE_KEY` | Base64-encoded private key (alternative to file) |
| `ZYND_REGISTRY_URL` | Registry URL override |
| `ZYND_HOME` | Config directory (default: `~/.zynd`) |
| `ZYND_ENTITY_URL` | Public base URL for the entity (overrides config) |

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
wss://dns01.zynd.ai/v1/entities/<entity_id>/ws
```

Every **30 seconds** it sends a signed ping:

```json
{ "timestamp": "2026-04-27T12:00:00.000Z", "signature": "ed25519:..." }
```

The timestamp is signed with the entity's private key. The registry uses this to determine liveness. If the connection drops, the SDK reconnects automatically after 5 seconds (configurable via `autoReconnect`).

### Webhook

`agent.start()` binds an Express server on `webhookPort` (default 5000). The ZyndAI Network sends messages to this server. **The URL registered with the network must be publicly reachable from the internet — `localhost` will not work.**

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

The webhook server fails hard on `EADDRINUSE` — it does not silently move to a different port. If port 5000 is in use, stop the conflicting process or set a different `webhookPort`.

#### Webhook endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | Async message — returns `{ status: "received", message_id }` immediately; handler runs in background |
| `/webhook/sync` | POST | Sync request/response — waits up to **30 seconds** for `setResponse(messageId, ...)` before returning 408 |
| `/webhook/response/:message_id` | GET | Poll for an async response by message ID |
| `/health` | GET | `{ status: "ok", entity_id, timestamp }` |
| `/.well-known/agent.json` | GET | Signed entity card with capabilities, endpoints, pricing, and schemas |

#### Payload format

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

### Webhook signature verification

The entity card at `/.well-known/agent.json` is signed with the entity's Ed25519 private key. Callers can verify it:

```ts
import { verify } from "zyndai";

const card = await fetch("https://your-agent.com/.well-known/agent.json").then(r => r.json());
const isValid = verify(
  card.public_key.replace("ed25519:", ""),
  new TextEncoder().encode(JSON.stringify({ ...card, signature: undefined })),
  card.signature,
);
```

### Entity card

The entity card is written to `.well-known/agent.json` on startup and served live at `GET /.well-known/agent.json`:

```json
{
  "entity_id": "zns:a90cb541...",
  "public_key": "ed25519:jfYH...",
  "name": "stock-agent",
  "version": "1.0",
  "status": "online",
  "capabilities": [{ "name": "nlp", "category": "ai" }],
  "endpoints": {
    "invoke": "https://example.com/webhook/sync",
    "invoke_async": "https://example.com/webhook",
    "health": "https://example.com/health",
    "agent_card": "https://example.com/.well-known/agent.json"
  },
  "pricing": {
    "model": "per-request",
    "currency": "USDC",
    "rates": { "default": 0.01 },
    "payment_methods": ["x402"]
  },
  "input_schema": { "type": "object", "properties": { "prompt": { "type": "string" } } },
  "output_schema": { "type": "object", "properties": { "response": { "type": "string" } } },
  "signature": "ed25519:bFRE..."
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

The ETH payment address is derived deterministically from the Ed25519 private key via `SHA-256(privateKeyBytes)`.

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

### `zynd init`

Create the developer identity. Must be run once before `zynd agent init` or `zynd service init`.

```
Options:
  --force    Overwrite existing developer key
```

Writes `~/.zynd/developer.json` (mode 0600) and `~/.zynd/config.json`.

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
agent.config.json     runtime config (name, framework, language, port, registry URL, derivation index)
agent.ts              framework-specific entry point
payload.ts            Zod RequestPayload / ResponsePayload schemas
.env                  ZYND_AGENT_KEYPAIR_PATH, ZYND_REGISTRY_URL, framework API key stubs
package.json          pre-configured with start script and framework deps
tsconfig.json
.gitignore
.well-known/agent.json  placeholder, regenerated on first run
```

Keypair is stored at `~/.zynd/agents/<slug>/keypair.json`, referenced from `.env`.

### `zynd agent run`

Start the agent from the current directory.

```
Options:
  --port <number>    Override webhook port
```

Reads `agent.config.json`, detects the language, spawns `npx tsx agent.ts` (TS) or `python3 agent.py` (Python). Falls back to an in-process echo agent if no entry file exists.

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
  --port <number>    Override webhook port
```

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
- Same entity ID derivation (`SHA-256` first 16 bytes)
- Same HD key derivation (`SHA-512`)
- Same registry API (signed registration, search, heartbeat)
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
