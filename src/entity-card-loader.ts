import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Ed25519Keypair, keypairFromPrivateBytes, loadKeypair } from "./identity";
import { signEntityCard, buildEndpoints, canonicalJson } from "./entity-card";
import { EntityCard, EntityCardPricing, ZyndBaseConfig } from "./types";

// Fields included in the card hash — covers all metadata that affects content identity.
const HASH_FIELDS: ReadonlyArray<keyof EntityCard> = [
  "name",
  "description",
  "capabilities",
  "category",
  "tags",
  "pricing",
  "summary",
];

export interface StaticEntityCard {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  tags?: string[];
  summary?: string;
  capabilities?: Array<{ name: string; category: string }>;
  pricing?: EntityCardPricing;
}

export interface ResolveKeypairConfig {
  keypairPath?: string;
  configDir?: string;
}

/**
 * Read a JSON file and validate it contains at minimum a `name` field.
 * Throws with a descriptive message on missing file, invalid JSON, or absent name.
 */
export function loadEntityCard(filePath: string): StaticEntityCard {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Entity card file not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read entity card at ${filePath}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in entity card at ${filePath}`, { cause: err });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Entity card at ${filePath} must be a JSON object`);
  }

  const card = parsed as Record<string, unknown>;
  if (typeof card["name"] !== "string" || card["name"].trim() === "") {
    throw new Error(`Entity card at ${filePath} is missing required field: name`);
  }

  return card as unknown as StaticEntityCard;
}

/**
 * Resolve a keypair using the following priority chain:
 *   1. ZYND_AGENT_KEYPAIR_PATH env — path to a keypair JSON file
 *   2. ZYND_AGENT_PRIVATE_KEY env — base64-encoded private key bytes
 *   3. config.keypairPath — path to a keypair JSON file
 *   4. .agent/config.json in cwd — reads private_key field (base64)
 *
 * Throws if no keypair source is found.
 */
export function resolveKeypair(config: ResolveKeypairConfig = {}): Ed25519Keypair {
  const envKeypairPath = process.env["ZYND_AGENT_KEYPAIR_PATH"];
  if (envKeypairPath) {
    return loadKeypair(envKeypairPath);
  }

  const envPrivateKey = process.env["ZYND_AGENT_PRIVATE_KEY"];
  if (envPrivateKey) {
    const privateBytes = new Uint8Array(Buffer.from(envPrivateKey, "base64"));
    return keypairFromPrivateBytes(privateBytes);
  }

  if (config.keypairPath) {
    return loadKeypair(config.keypairPath);
  }

  // Fall back to .agent/config.json which stores the agent identity including private_key.
  const configDir = config.configDir ?? ".agent";
  const configFilePath = path.join(process.cwd(), configDir, "config.json");
  if (fs.existsSync(configFilePath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(configFilePath, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read agent config at ${configFilePath}`, { cause: err });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in agent config at ${configFilePath}`, { cause: err });
    }

    const data = parsed as Record<string, unknown>;
    if (typeof data["private_key"] === "string") {
      const privateBytes = new Uint8Array(Buffer.from(data["private_key"], "base64"));
      return keypairFromPrivateBytes(privateBytes);
    }
  }

  throw new Error(
    "No keypair found. Set ZYND_AGENT_KEYPAIR_PATH, ZYND_AGENT_PRIVATE_KEY, " +
      "pass keypairPath, or ensure .agent/config.json exists with a private_key field."
  );
}

/**
 * Merge static card metadata with runtime identity and sign the result.
 * Copies: name, description, version, category, tags, summary, capabilities, pricing.
 */
export function buildRuntimeCard(
  staticCard: StaticEntityCard,
  baseUrl: string,
  keypair: Ed25519Keypair
): EntityCard {
  const now = new Date().toISOString();
  const base = baseUrl.replace(/\/+$/, "");

  const card: EntityCard = {
    entity_id: keypair.entityId,
    name: staticCard.name,
    description: staticCard.description ?? "",
    public_key: keypair.publicKeyString,
    entity_url: base,
    version: staticCard.version ?? "1.0",
    status: "online",
    capabilities: staticCard.capabilities ?? [],
    endpoints: buildEndpoints(base),
    last_heartbeat: now,
    signed_at: now,
  };

  if (staticCard.category !== undefined) card.category = staticCard.category;
  if (staticCard.tags !== undefined) card.tags = staticCard.tags;
  if (staticCard.summary !== undefined) card.summary = staticCard.summary;
  if (staticCard.pricing !== undefined) card.pricing = staticCard.pricing;

  return signEntityCard(card, keypair);
}

/**
 * SHA-256 of canonical JSON of the metadata fields that define card content identity.
 * Deterministic: same input always produces the same hex digest.
 */
export function computeCardHash(card: Partial<EntityCard>): string {
  const subset: Record<string, unknown> = {};
  for (const field of HASH_FIELDS) {
    // Include the field even when undefined so the hash covers the full field set.
    subset[field] = (card as Record<string, unknown>)[field] ?? null;
  }
  const payload = canonicalJson(subset);
  const digest = sha256(new TextEncoder().encode(payload));
  return bytesToHex(digest);
}

/**
 * Build a static card dict from a ZyndBaseConfig.
 * Capabilities are converted from dict format {category: [name, ...]} to flat list.
 * Pricing is resolved from entityPricing (structured) or price (string) fields.
 */
export function resolveCardFromConfig(config: ZyndBaseConfig): StaticEntityCard {
  const card: StaticEntityCard = {
    name: config.name,
    description: config.description,
    category: config.category,
    version: "1.0",
  };

  if (config.tags !== undefined) card.tags = config.tags;
  if (config.summary !== undefined) card.summary = config.summary;

  if (config.capabilities !== undefined) {
    card.capabilities = flattenCapabilitiesDict(config.capabilities);
  }

  if (config.entityPricing !== undefined) {
    // Convert structured pricing to EntityCardPricing.
    card.pricing = {
      model: "per-request",
      currency: config.entityPricing.currency,
      rates: { default: config.entityPricing.base_price_usd },
      payment_methods: ["x402"],
    };
  } else if (config.price !== undefined) {
    card.pricing = parsePriceString(config.price);
  }

  return card;
}

/**
 * Read a keypair JSON file and return the derived_from metadata object, or null
 * if the file does not contain that field.
 */
export function loadDerivationMetadata(keypairPath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(keypairPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read keypair at ${keypairPath}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in keypair file at ${keypairPath}`, { cause: err });
  }

  const data = parsed as Record<string, unknown>;
  const derivedFrom = data["derived_from"];
  if (derivedFrom !== undefined && derivedFrom !== null && typeof derivedFrom === "object") {
    return derivedFrom as Record<string, unknown>;
  }
  return null;
}

function flattenCapabilitiesDict(
  capabilities: Record<string, unknown>
): Array<{ name: string; category: string }> {
  const result: Array<{ name: string; category: string }> = [];
  for (const [category, names] of Object.entries(capabilities)) {
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === "string") {
          result.push({ name, category });
        }
      }
    }
  }
  return result;
}

function parsePriceString(price: string): EntityCardPricing {
  // Strip leading currency symbols ($, €, etc.) then parse the numeric portion.
  const numeric = parseFloat(price.replace(/^[^0-9.]+/, ""));
  return {
    model: "per-request",
    currency: "USDC",
    rates: { default: isNaN(numeric) ? 0 : numeric },
    payment_methods: ["x402"],
  };
}
