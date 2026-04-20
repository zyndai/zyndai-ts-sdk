import { Ed25519Keypair, sign } from "./identity";
import { EntityCard, EntityCardPricing, EntityEndpoints } from "./types";

export function buildEndpoints(baseUrl: string): EntityEndpoints {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    invoke: `${base}/webhook/sync`,
    invoke_async: `${base}/webhook`,
    health: `${base}/health`,
    agent_card: `${base}/.well-known/agent.json`,
  };
}

// Recursive canonical JSON: sorted keys, no whitespace — matches Go's encoding/json Marshal order.
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean" || typeof obj === "number") return JSON.stringify(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  if (typeof obj === "object") {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`);
    return "{" + sorted.join(",") + "}";
  }
  return JSON.stringify(obj);
}

interface BuildEntityCardOpts {
  entityId: string;
  name: string;
  description: string;
  entityUrl: string;
  keypair: Ed25519Keypair;
  capabilities?: Record<string, string[]>;
  price?: string;
  version?: string;
}

function parsePricing(price: string): EntityCardPricing {
  const numeric = parseFloat(price.replace(/^[^0-9.]+/, ""));
  return {
    model: "per-request",
    currency: "USDC",
    rates: { default: isNaN(numeric) ? 0 : numeric },
    payment_methods: ["x402"],
  };
}

function flattenCapabilities(
  capabilities: Record<string, string[]>
): Array<{ name: string; category: string }> {
  const result: Array<{ name: string; category: string }> = [];
  for (const [category, names] of Object.entries(capabilities)) {
    for (const name of names) {
      result.push({ name, category });
    }
  }
  return result;
}

function stripWebhookSuffix(url: string): string {
  // Remove trailing slashes first, then strip /webhook if present.
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/webhook") ? trimmed.slice(0, -"/webhook".length) : trimmed;
}

export function buildEntityCard(opts: BuildEntityCardOpts): EntityCard {
  const {
    entityId,
    name,
    description,
    entityUrl,
    keypair,
    capabilities = {},
    price,
    version = "1.0",
  } = opts;

  const baseUrl = stripWebhookSuffix(entityUrl);
  const now = new Date().toISOString();

  const card: EntityCard = {
    entity_id: entityId,
    name,
    description,
    public_key: keypair.publicKeyString,
    entity_url: baseUrl,
    version,
    status: "online",
    capabilities: flattenCapabilities(capabilities),
    endpoints: buildEndpoints(baseUrl),
    last_heartbeat: now,
    signed_at: now,
  };

  if (price !== undefined) {
    card.pricing = parsePricing(price);
  }

  return card;
}

export function signEntityCard(card: EntityCard, keypair: Ed25519Keypair): EntityCard {
  // Build a copy without the signature field before signing to avoid including
  // a stale or empty signature value in the canonical payload.
  const { signature: _removed, ...cardWithoutSig } = card;
  const payload = canonicalJson(cardWithoutSig);
  const signature = sign(keypair.privateKeyBytes, new TextEncoder().encode(payload));
  return { ...cardWithoutSig, signature };
}
