/**
 * A2A-shaped Agent Card builder.
 *
 * The card published at `/.well-known/agent-card.json` is the canonical A2A
 * shape (https://a2a-protocol.org/v0.3.0/specification/#agent-card) plus a
 * single `x-zynd` extension namespace that carries Zynd-specific fields
 * (entity_id, public_key, fqan, pricing, derivation proof, registry, etc.).
 *
 * The card is signed using a `signatures` array of JWS-style detached
 * signatures over the JCS-canonicalized card body (with the signatures
 * field itself omitted from the canonical bytes). This matches the A2A
 * spec which references RFC 7515 + RFC 8785.
 */

import { z } from "zod";
import { sign as edSign } from "../identity.js";
import type { Ed25519Keypair } from "../identity.js";
import { canonicalBytes } from "./canonical.js";
import { zodSchemaAdvertisement } from "../payload-schema.js";

// -----------------------------------------------------------------------------
// Card config — what callers (and the CLI) supply via *.config.json
// -----------------------------------------------------------------------------

export interface AgentCardSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCardProvider {
  organization: string;
  url?: string;
}

export interface AgentCardCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentCardSecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
}

export interface BuildCardOptions {
  // Required A2A fields
  name: string;
  description: string;
  version: string;
  baseUrl: string;
  /** Agent's Ed25519 keypair — used to sign the card. */
  keypair: Ed25519Keypair;
  entityId: string;

  // A2A optional
  protocolVersion?: string; // default "0.3.0"
  provider?: AgentCardProvider;
  iconUrl?: string;
  documentationUrl?: string;
  capabilities?: AgentCardCapabilities;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: AgentCardSkill[];
  securitySchemes?: Record<string, AgentCardSecurityScheme>;
  security?: Array<Record<string, string[]>>;

  // Schema advertisement (JSON Schemas derived from Zod)
  payloadModel?: z.ZodTypeAny;
  outputModel?: z.ZodTypeAny;

  // Zynd extension fields
  fqan?: string;
  registry?: string;
  pricing?: {
    model: string;
    currency: string;
    rates: Record<string, number>;
    paymentMethods: string[];
  };
  trustScore?: number;
  status?: string;
  developerProof?: {
    developer_public_key: string;
    entity_index: number;
    developer_signature: string;
  };
  category?: string;
  tags?: string[];
  summary?: string;

  /** A2A endpoint path. Default `/a2a/v1`. */
  a2aPath?: string;
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

const DEFAULT_PROTOCOL_VERSION = "0.3.0";

export interface SignedAgentCard extends Record<string, unknown> {
  protocolVersion: string;
  name: string;
  description: string;
  version: string;
  url: string;
  preferredTransport: "JSONRPC";
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
  signatures: Array<{
    protected: string;
    signature: string;
    header?: Record<string, unknown>;
  }>;
}

export function buildAgentCard(opts: BuildCardOptions): SignedAgentCard {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const a2aPath = opts.a2aPath ?? "/a2a/v1";
  const a2aUrl = `${baseUrl}${a2aPath}`;

  // Default capabilities: we serve message/stream and tasks/pushNotificationConfig.
  const capabilities: AgentCardCapabilities = {
    streaming: true,
    pushNotifications: true,
    stateTransitionHistory: false,
    ...opts.capabilities,
  };

  // Auto-derive defaultInputModes / defaultOutputModes from the payloadModel
  // if the operator didn't supply them explicitly.
  const schemaAd = zodSchemaAdvertisement(opts.payloadModel, opts.outputModel);

  const defaultInputModes =
    opts.defaultInputModes ?? deriveDefaultModes("input", schemaAd);
  const defaultOutputModes =
    opts.defaultOutputModes ?? deriveDefaultModes("output", schemaAd);

  // Default skill if none supplied — every agent gets at least one entry so
  // discovery can match.
  const skills: AgentCardSkill[] =
    opts.skills && opts.skills.length > 0
      ? opts.skills
      : [
          {
            id: "default",
            name: opts.name,
            description: opts.description,
            ...(opts.tags ? { tags: opts.tags } : {}),
            inputModes: defaultInputModes,
            outputModes: defaultOutputModes,
          },
        ];

  const securitySchemes: Record<string, AgentCardSecurityScheme> =
    opts.securitySchemes ?? {
      zyndSig: {
        type: "http",
        scheme: "ed25519-envelope",
        description:
          "Per-message Ed25519 signature in Message.metadata['x-zynd-auth']. See zynd-a2a-communication spec.",
      },
    };
  const security = opts.security ?? [{ zyndSig: [] }];

  // x-zynd extension block — everything Zynd-specific lives here.
  const xZynd: Record<string, unknown> = {
    version: 1,
    entityId: opts.entityId,
    publicKey: opts.keypair.publicKeyString,
    ...(opts.fqan ? { fqan: opts.fqan } : {}),
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.pricing ? { pricing: opts.pricing } : {}),
    ...(opts.trustScore !== undefined ? { trustScore: opts.trustScore } : {}),
    ...(opts.status ? { status: opts.status } : { status: "online" }),
    ...(opts.developerProof ? { developerProof: opts.developerProof } : {}),
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.summary ? { summary: opts.summary } : {}),
    ...(schemaAd.input_schema ? { inputSchema: schemaAd.input_schema } : {}),
    ...(schemaAd.output_schema ? { outputSchema: schemaAd.output_schema } : {}),
    ...(schemaAd.accepts_files !== undefined ? { acceptsFiles: schemaAd.accepts_files } : {}),
    lastUpdatedAt: new Date().toISOString(),
  };

  const unsigned: Record<string, unknown> = {
    protocolVersion: opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    name: opts.name,
    description: opts.description,
    version: opts.version,
    url: a2aUrl,
    preferredTransport: "JSONRPC",
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.iconUrl ? { iconUrl: opts.iconUrl } : {}),
    ...(opts.documentationUrl ? { documentationUrl: opts.documentationUrl } : {}),
    capabilities,
    defaultInputModes,
    defaultOutputModes,
    skills,
    securitySchemes,
    security,
    "x-zynd": xZynd,
  };

  return signAgentCard(unsigned, opts.keypair) as SignedAgentCard;
}

// -----------------------------------------------------------------------------
// Sign
// -----------------------------------------------------------------------------

/**
 * Sign an unsigned card. The signature covers the JCS-canonical bytes of
 * the card with the `signatures` field omitted.
 *
 * Format: JWS-compact-style with detached payload, encoded as a single
 * entry inside the `signatures` array.
 *   protected: base64url(JSON({ alg: "EdDSA", typ: "agent-card+jcs+jws" }))
 *   signature: base64url(ed25519-signature)
 *   header.kid: the agent's public key string (so verifiers know which
 *               key to look up).
 */
export function signAgentCard(card: Record<string, unknown>, keypair: Ed25519Keypair): Record<string, unknown> {
  const stripped = { ...card };
  delete stripped["signatures"];
  delete stripped["signature"];

  const protectedHeader = { alg: "EdDSA", typ: "agent-card+jcs+jws" };
  const protectedB64 = base64UrlEncodeJson(protectedHeader);
  const payloadBytes = canonicalBytes(stripped);

  // Detached JWS signing input: ASCII(protected) || "." || payload
  const dot = new TextEncoder().encode(".");
  const headerBytes = new TextEncoder().encode(protectedB64);
  const sigInput = new Uint8Array(headerBytes.length + dot.length + payloadBytes.length);
  sigInput.set(headerBytes, 0);
  sigInput.set(dot, headerBytes.length);
  sigInput.set(payloadBytes, headerBytes.length + dot.length);

  const signature = edSign(keypair.privateKeyBytes, sigInput);
  // strip "ed25519:" prefix and re-encode as base64url for JWS conformance
  const rawSig = signature.startsWith("ed25519:") ? signature.slice("ed25519:".length) : signature;
  const sigB64Url = base64ToBase64Url(rawSig);

  return {
    ...card,
    signatures: [
      {
        protected: protectedB64,
        signature: sigB64Url,
        header: { kid: keypair.publicKeyString },
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function base64UrlEncodeJson(obj: unknown): string {
  const s = JSON.stringify(obj);
  const b64 = Buffer.from(s, "utf-8").toString("base64");
  return base64ToBase64Url(b64);
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function deriveDefaultModes(
  side: "input" | "output",
  schemaAd: ReturnType<typeof zodSchemaAdvertisement>,
): string[] {
  const out = ["text/plain", "application/json"];
  if (side === "input" && schemaAd.accepts_files) {
    out.push("multipart/form-data");
  }
  return out;
}
