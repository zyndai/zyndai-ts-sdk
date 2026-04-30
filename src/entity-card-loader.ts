/**
 * Card / config loader.
 *
 * Two roles:
 *   1. Resolve the agent's keypair from environment / config / disk.
 *   2. Build the A2A-shaped agent card from a ZyndBaseConfig at runtime.
 *
 * The card itself is constructed by `a2a/card.ts`; this module is a thin
 * adapter that pulls fields off the parsed config and hands them to
 * `buildAgentCard`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  Ed25519Keypair,
  keypairFromPrivateBytes,
  loadKeypair,
  generateDeveloperId,
  defaultDeveloperKeyPath,
} from "./identity.js";
import type { ZyndBaseConfig } from "./types.js";
import {
  buildAgentCard,
  type BuildCardOptions,
  type SignedAgentCard,
  type AgentCardProvider,
} from "./a2a/card.js";
import { getDeveloper } from "./registry.js";

export interface ResolveKeypairConfig {
  keypairPath?: string;
  configDir?: string;
}

/**
 * Resolve the agent keypair using the following priority chain:
 *   1. ZYND_AGENT_KEYPAIR_PATH env  → keypair JSON file
 *   2. ZYND_AGENT_PRIVATE_KEY env   → base64 private key bytes
 *   3. config.keypairPath           → keypair JSON file
 *   4. .agent/config.json in cwd    → reads private_key field (base64)
 *
 * Throws if no source is found.
 */
export function resolveKeypair(config: ResolveKeypairConfig = {}): Ed25519Keypair {
  const envKeypairPath = process.env["ZYND_AGENT_KEYPAIR_PATH"];
  if (envKeypairPath) return loadKeypair(envKeypairPath);

  const envPrivateKey = process.env["ZYND_AGENT_PRIVATE_KEY"];
  if (envPrivateKey) {
    const privateBytes = new Uint8Array(Buffer.from(envPrivateKey, "base64"));
    return keypairFromPrivateBytes(privateBytes);
  }

  if (config.keypairPath) return loadKeypair(config.keypairPath);

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
      "pass keypairPath, or ensure .agent/config.json exists with a private_key field.",
  );
}

/**
 * Read a keypair JSON file and return the `derived_from` metadata, if any.
 * Used to reconstruct the developer derivation proof at registration time.
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
  if (derivedFrom && typeof derivedFrom === "object") {
    return derivedFrom as Record<string, unknown>;
  }
  return null;
}

// -----------------------------------------------------------------------------
// A2A card building from the SDK config
// -----------------------------------------------------------------------------

export interface BuildRuntimeCardArgs {
  config: ZyndBaseConfig;
  baseUrl: string;
  keypair: Ed25519Keypair;
  entityId: string;
  payloadModel?: z.ZodTypeAny;
  outputModel?: z.ZodTypeAny;
  developerProof?: BuildCardOptions["developerProof"];
  /**
   * Provider block to use when `config.provider` is missing or its
   * `organization` is empty. Typically resolved once at agent startup via
   * `resolveProviderFromDeveloper()` and cached for the process lifetime.
   */
  fallbackProvider?: AgentCardProvider;
}

/**
 * Resolve the AgentCard `provider` block from the developer's identity.
 *
 * Reads the local developer keypair (~/.zynd/developer.json by default),
 * derives the developer_id, fetches the developer record from the
 * registry, and builds a provider block using:
 *   - organization: dev_handle if claimed, else dev name
 *   - url: home_registry from the registry record
 *
 * Returns null when:
 *   - developer keypair file is missing (no `zynd auth login` yet)
 *   - the registry has no record for that developer (handle never claimed)
 *   - the registry call fails (network error, etc.) — non-fatal
 *
 * Network failures resolve to null rather than throwing so agent startup
 * doesn't get blocked by a flaky registry.
 */
export async function resolveProviderFromDeveloper(opts: {
  registryUrl: string;
  developerKeypairPath?: string;
}): Promise<AgentCardProvider | null> {
  const keyPath = opts.developerKeypairPath ?? defaultDeveloperKeyPath();
  if (!fs.existsSync(keyPath)) return null;

  let devKp;
  try {
    devKp = loadKeypair(keyPath);
  } catch {
    return null;
  }

  const developerId = generateDeveloperId(devKp.publicKeyBytes);

  let record: Record<string, unknown> | null;
  try {
    record = await getDeveloper(opts.registryUrl, developerId);
  } catch {
    return null;
  }
  if (!record) return null;

  const handle =
    typeof record["dev_handle"] === "string" && record["dev_handle"]
      ? (record["dev_handle"] as string)
      : null;
  const name = typeof record["name"] === "string" ? (record["name"] as string) : null;
  const homeRegistry =
    typeof record["home_registry"] === "string"
      ? (record["home_registry"] as string)
      : registryHostFromUrl(opts.registryUrl);

  const organization = handle ?? name ?? "";
  if (!organization) return null;

  const provider: AgentCardProvider = { organization };
  if (homeRegistry) {
    provider.url = homeRegistry.startsWith("http")
      ? homeRegistry
      : `https://${homeRegistry}`;
  }
  return provider;
}

/**
 * Build the A2A-shaped agent card directly from a ZyndBaseConfig + runtime
 * identity. The card is fully signed and ready to ship over the wire.
 */
export function buildRuntimeCard(args: BuildRuntimeCardArgs): SignedAgentCard {
  const { config, baseUrl, keypair, entityId, payloadModel, outputModel } = args;

  const pricing = config.entityPricing
    ? {
        model: "per-request",
        currency: config.entityPricing.currency,
        rates: { default: config.entityPricing.base_price_usd },
        paymentMethods: ["x402"],
      }
    : config.price
      ? parsePriceString(config.price)
      : undefined;

  const cardOpts: BuildCardOptions = {
    name: config.name,
    description: config.description ?? "",
    version: config.version,
    baseUrl,
    keypair,
    entityId,
    protocolVersion: config.protocolVersion,
    a2aPath: config.a2aPath,
  };
  // Provider precedence: config.provider (if it has a real organization),
  // then args.fallbackProvider (resolved from developer.json + registry),
  // then nothing.
  const provider = pickProvider(config.provider, args.fallbackProvider);
  if (provider) cardOpts.provider = provider;
  if (config.iconUrl) cardOpts.iconUrl = config.iconUrl;
  if (config.documentationUrl) cardOpts.documentationUrl = config.documentationUrl;
  if (config.capabilities) cardOpts.capabilities = config.capabilities;
  if (config.defaultInputModes) cardOpts.defaultInputModes = config.defaultInputModes;
  if (config.defaultOutputModes) cardOpts.defaultOutputModes = config.defaultOutputModes;
  if (config.skills) cardOpts.skills = config.skills;
  if (payloadModel) cardOpts.payloadModel = payloadModel;
  if (outputModel) cardOpts.outputModel = outputModel;
  if (config.fqan) cardOpts.fqan = config.fqan;
  if (pricing) cardOpts.pricing = pricing;
  if (args.developerProof) cardOpts.developerProof = args.developerProof;
  if (config.category) cardOpts.category = config.category;
  if (config.tags) cardOpts.tags = config.tags;
  // The card no longer carries a separate `summary` field — the
  // x-zynd.summary slot was redundant with `description`. Search
  // consumers should read `description` (or compute their own snippet
  // from it).

  const registryHost = registryHostFromUrl(config.registryUrl);
  if (registryHost) cardOpts.registry = registryHost;

  return buildAgentCard(cardOpts);
}

function parsePriceString(price: string): {
  model: string;
  currency: string;
  rates: Record<string, number>;
  paymentMethods: string[];
} {
  const numeric = parseFloat(price.replace(/^[^0-9.]+/, ""));
  return {
    model: "per-request",
    currency: "USDC",
    rates: { default: isNaN(numeric) ? 0 : numeric },
    paymentMethods: ["x402"],
  };
}

function registryHostFromUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Pick the right provider for the agent card. The user's hand-edited
 * `config.provider` always wins when its organization is non-empty,
 * because they explicitly chose to set it. An empty/missing config
 * provider falls through to the dev-resolved fallback. This way the CLI
 * can scaffold `provider: { organization: "" }` without it overriding
 * the auto-resolved value.
 */
function pickProvider(
  fromConfig: AgentCardProvider | undefined,
  fallback: AgentCardProvider | undefined,
): AgentCardProvider | undefined {
  const hasRealConfig =
    fromConfig &&
    typeof fromConfig.organization === "string" &&
    fromConfig.organization.trim().length > 0;
  if (hasRealConfig) return fromConfig;
  return fallback;
}
