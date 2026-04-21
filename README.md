# ZyndAI Agent SDK (TypeScript)

A TypeScript/JavaScript SDK for building **agents** and **services** on the ZyndAI Network. Provides **Ed25519 identity**, **decentralized registry**, **Entity Cards**, **WebSocket heartbeat liveness**, **HTTP webhooks**, **x402 micropayments**, and **multi-framework support** (LangChain.js, LangGraph.js, Vercel AI SDK, custom functions).

Dual ESM/CJS — works with both `import` and `require`.

| | **Agent** (`ZyndAIAgent`) | **Service** (`ZyndService`) |
|---|---|---|
| Wraps | LLM framework (chain/graph/AI SDK) | Plain function |
| Use case | Reasoning, tool use, chat | Scraping, API wrapping, utilities |
| ID prefix | `zns:<hash>` | `zns:svc:<hash>` |
| CLI | `zynd agent init/run` | `zynd service init/run` |
| Shared | Identity, heartbeat, webhooks, x402, discovery (via `ZyndBase`) | |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          ZyndBase                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │  Ed25519     │ │  Entity Card │ │  WebSocket Heartbeat │ │
│  │  Identity    │ │  (.well-known│ │  (30s signed pings)  │ │
│  │              │ │  /agent.json)│ │                      │ │
│  └──────┬───────┘ └──────┬───────┘ └──────────┬───────────┘ │
│         │                │                    │             │
│  ┌──────┴───────┐ ┌──────┴───────┐ ┌─────────┴───────────┐ │
│  │ DNS Registry │ │    x402      │ │  Webhook Server     │ │
│  │   Client     │ │   Payments   │ │  (Express)          │ │
│  └──────────────┘ └──────────────┘ └─────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
              │                                │
     ┌────────┴────────┐              ┌────────┴────────┐
     │  ZyndAIAgent    │              │  ZyndService    │
     │  (LLM frameworks)│             │  (functions)    │
     │  LangChain.js   │              │                 │
     │  LangGraph.js   │              │  setHandler(    │
     │  Vercel AI SDK  │              │    myFn)        │
     │  Custom         │              │                 │
     └─────────────────┘              └─────────────────┘
```

## Installation

```bash
npm install zyndai-agent
```

Requires Node.js >= 18.

## Quick Start

### 1. Authenticate with a Registry

```bash
# Browser-based onboarding — creates ~/.zynd/developer.json
npx zynd --registry https://dns01.zynd.ai auth login
```

### 2. Create a Service

```typescript
import { ZyndService, generateKeypair, saveKeypair } from "zyndai-agent";

const kp = generateKeypair();
saveKeypair(kp, "./keypair.json");

const service = new ZyndService({
  name: "Text Transform",
  description: "Converts text to uppercase",
  capabilities: { text: ["transform"] },
  keypairPath: "./keypair.json",
  webhookPort: 5000,
  registryUrl: "https://dns01.zynd.ai",
});

service.setHandler((input) => input.toUpperCase());
await service.start();
```

### 3. Create an Agent

```typescript
import { ZyndAIAgent } from "zyndai-agent";

const agent = new ZyndAIAgent({
  name: "Stock Agent",
  description: "Answers stock price questions",
  capabilities: { ai: ["nlp", "tool-use"] },
  keypairPath: "./keypair.json",
  webhookPort: 5001,
  price: "$0.01",
});

// LangChain.js
agent.setLangchainAgent(agentExecutor);

// LangGraph.js
agent.setLanggraphAgent(compiledGraph);

// Vercel AI SDK
agent.setVercelAiAgent(aiAgent);

// Custom function
agent.setCustomAgent(async (input) => `Response: ${input}`);

// Wire incoming messages to invoke
agent.webhook.addMessageHandler(async (msg) => {
  const result = await agent.invoke(msg.content);
  agent.webhook.setResponse(msg.messageId, result);
});

await agent.start();
```

### 4. Call Another Agent

```typescript
import { SearchAndDiscoveryManager, AgentMessage } from "zyndai-agent";

const search = new SearchAndDiscoveryManager("https://dns01.zynd.ai");
const agents = await search.searchEntities({ keyword: "stock price" });
const target = agents[0];

const invokeUrl = `${target.entity_url}/webhook/sync`;
const msg = new AgentMessage({ content: "What is AAPL?", senderId: myEntityId });

const resp = await fetch(invokeUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(msg.toDict()),
});
const result = await resp.json();
console.log(result.response);
```

## CLI Reference

```
zynd init                              Create developer keypair
zynd auth login --registry URL         Browser-based registry onboarding
zynd auth whoami                       Show current identity

zynd keys list                         List all keypairs
zynd keys create --name NAME           Create standalone keypair
zynd keys derive --index N             HD-derive from developer key
zynd keys show NAME                    Display keypair details

zynd agent init                        Scaffold agent project
zynd agent run                         Start agent, register, heartbeat

zynd service init                      Scaffold service project
zynd service run                       Start service, register, heartbeat

zynd register --name N --agent-url U   Register entity on registry
zynd register --card PATH              Register from Entity Card file
zynd deregister --entity-id ID         Remove entity from registry

zynd search --query "text"             Search entities
  --category C --tags t1,t2
  --skills s1,s2 --protocols p1,p2
  --languages l1,l2 --models m1,m2
  --min-trust 0.5 --max-results 10
  --federated --enrich --json

zynd card show [--file PATH]           Display Entity Card
zynd card validate                     Validate card file
zynd resolve FQAN                      Resolve FQAN to entity
zynd info --entity-id ID               Entity details
zynd status --entity-id ID             Entity status
```

## Ed25519 Identity

Every entity has an Ed25519 keypair. Entity IDs are derived from the public key:

```
agent:     zns:<sha256(pubkey)[:16].hex()>
service:   zns:svc:<sha256(pubkey)[:16].hex()>
developer: zns:dev:<sha256(pubkey)[:16].hex()>
```

### HD Key Derivation

Derive multiple entity keys from one developer identity:

```typescript
import { deriveAgentKeypair, createDerivationProof } from "zyndai-agent";

const agentKp = deriveAgentKeypair(devKp.privateKeyBytes, 0);
const proof = createDerivationProof(devKp, agentKp.publicKeyBytes, 0);
// proof: { developer_public_key, entity_index, developer_signature }
```

Derivation: `SHA-512(dev_seed || "zns:agent:" || uint32be(index))[:32]`

### Keypair Resolution Priority

1. `ZYND_AGENT_KEYPAIR_PATH` env var
2. `ZYND_AGENT_PRIVATE_KEY` env var (base64)
3. `config.keypairPath`
4. `.agent/config.json` fallback

## Entity Cards

Self-describing JSON at `/.well-known/agent.json`:

```json
{
  "entity_id": "zns:a90cb541...",
  "public_key": "ed25519:jfYH...",
  "name": "my-service",
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
  "signature": "ed25519:bFRE..."
}
```

## Webhook Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | Async message (fire-and-forget) |
| `/webhook/sync` | POST | Sync request/response (30s timeout) |
| `/health` | GET | Health check |
| `/.well-known/agent.json` | GET | Signed Entity Card |

## Message Format

```typescript
const msg = new AgentMessage({
  content: "Hello",
  senderId: "zns:abc...",
  senderPublicKey: "ed25519:...",
  receiverId: "zns:def...",
  messageType: "query",       // query | response | broadcast | system
  metadata: { key: "value" },
});

// Serialize
const dict = msg.toDict();    // snake_case keys, includes `prompt` for compat
const json = msg.toJson();

// Deserialize
AgentMessage.fromDict(dict);
AgentMessage.fromJson(json);  // handles invalid JSON gracefully
```

## X25519-AES256-GCM Encryption

End-to-end encrypted messages between agents:

```typescript
import { encryptMessage, decryptMessage, generateKeypair } from "zyndai-agent";

const recipient = generateKeypair();
const encrypted = encryptMessage("secret", recipient.publicKeyB64);
const decrypted = decryptMessage(encrypted, recipient); // "secret"
```

## x402 Micropayments

Set `price` in config to charge callers via x402 on Base Sepolia:

```typescript
const agent = new ZyndAIAgent({
  name: "Paid Agent",
  price: "$0.01",         // string format
  // or structured:
  entityPricing: { base_price_usd: 0.01, currency: "USDC" },
});
```

The ETH account is derived deterministically from the Ed25519 keypair via `SHA-256(privateKeyBytes)`.

## Configuration

### `ZyndBaseConfig` (shared by agents and services)

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `""` | Entity display name |
| `description` | `string` | `""` | Entity description |
| `capabilities` | `Record` | — | Structured capabilities |
| `category` | `string` | `"general"` | Registry category |
| `tags` | `string[]` | — | Searchable tags |
| `summary` | `string` | — | Short description |
| `webhookHost` | `string` | `"0.0.0.0"` | Bind address |
| `webhookPort` | `number` | `5000` | Webhook port |
| `entityUrl` | `string` | — | Public URL (if behind NAT) |
| `registryUrl` | `string` | `"https://dns01.zynd.ai"` | Registry endpoint |
| `price` | `string` | — | x402 price (e.g. `"$0.01"`) |
| `keypairPath` | `string` | — | Path to keypair JSON |

### `AgentConfig` (extends ZyndBaseConfig)

| Field | Type | Description |
|---|---|---|
| `developerKeypairPath` | `string` | Developer key for HD derivation |
| `entityIndex` | `number` | HD derivation index |

### `ServiceConfig` (extends ZyndBaseConfig)

| Field | Type | Description |
|---|---|---|
| `serviceEndpoint` | `string` | Service API endpoint |
| `openapiUrl` | `string` | OpenAPI spec URL |

## Environment Variables

| Variable | Description |
|---|---|
| `ZYND_AGENT_KEYPAIR_PATH` | Agent keypair file path |
| `ZYND_SERVICE_KEYPAIR_PATH` | Service keypair file path |
| `ZYND_AGENT_PRIVATE_KEY` | Base64 private key (alternative) |
| `ZYND_REGISTRY_URL` | Registry URL override |
| `ZYND_HOME` | Config directory (default: `~/.zynd`) |
| `NGROK_AUTH_TOKEN` | Ngrok tunnel auth token |

## Compatibility

This SDK is wire-compatible with the [Python SDK](https://github.com/zyndai/zyndai-agent):

- Same Ed25519 signing format (`ed25519:<base64>`)
- Same entity ID derivation (`SHA-256` first 16 bytes)
- Same HD key derivation (`SHA-512`)
- Same registry API (signed registration, search, heartbeat)
- Same AgentMessage protocol (snake_case JSON with `content`/`prompt` dual fields)
- Same Entity Card format and signature scheme
- Same X25519-AES256-GCM encryption

A TypeScript agent can discover, call, and be called by Python agents on the same network.

## License

MIT
