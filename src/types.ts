import { z } from "zod";

export enum AgentFramework {
  LANGCHAIN = "langchain",
  LANGGRAPH = "langgraph",
  CREWAI = "crewai",
  PYDANTIC_AI = "pydantic_ai",
  VERCEL_AI = "vercel_ai",
  MASTRA = "mastra",
  CUSTOM = "custom",
}

// -----------------------------------------------------------------------------
// Agent-card-driving config (lives inside *.config.json)
// -----------------------------------------------------------------------------

/**
 * Each agent in `agent.config.json` declares its skills here. The CLI/SDK
 * uses these to populate the A2A AgentCard's `skills[]` array. If omitted,
 * a single default skill is generated from the agent's name + description.
 */
export const SkillConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

export const ProviderConfigSchema = z.object({
  organization: z.string(),
  url: z.string().optional(),
});

export const PricingConfigSchema = z.object({
  base_price_usd: z.number(),
  currency: z.string().default("USDC"),
});

// -----------------------------------------------------------------------------
// Base config — fields shared by agents and services
// -----------------------------------------------------------------------------

export const ZyndBaseConfigSchema = z.object({
  // Display
  name: z.string().default(""),
  description: z.string().default(""),
  /** Agent semver (e.g. "1.0.0"). Defaults to "0.1.0" when omitted. */
  version: z.string().default("0.1.0"),

  // Discovery / search
  category: z.string().default("general"),
  tags: z.array(z.string()).optional(),
  // `summary` is intentionally omitted — derived from `description` at
  // registry-registration time so we don't ask users to maintain two
  // overlapping prose fields.

  // Network
  registryUrl: z.string().default("https://zns01.zynd.ai"),
  /** Public URL the agent advertises. Falls back to host/port derivation. */
  entityUrl: z.string().optional(),

  // A2A server bind
  /** Bind host. Default 0.0.0.0. */
  serverHost: z.string().default("0.0.0.0"),
  /** Bind port. Default 5000. */
  serverPort: z.number().int().default(5000),
  /** A2A endpoint path. Default /a2a/v1. */
  a2aPath: z.string().default("/a2a/v1"),
  /** Inbound auth mode for x-zynd-auth verification. */
  authMode: z.enum(["strict", "permissive", "open"]).default("permissive"),

  // Identity
  keypairPath: z.string().optional(),
  configDir: z.string().optional(),
  developerKeypairPath: z.string().optional(),
  entityIndex: z.number().int().optional(),

  // Card output
  /** Path to write the A2A AgentCard JSON. Default `.well-known/agent-card.json`. */
  cardOutput: z.string().optional(),

  // A2A AgentCard fields
  protocolVersion: z.string().default("0.3.0"),
  provider: ProviderConfigSchema.optional(),
  iconUrl: z.string().optional(),
  documentationUrl: z.string().optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      stateTransitionHistory: z.boolean().optional(),
    })
    .optional(),
  skills: z.array(SkillConfigSchema).optional(),
  fqan: z.string().optional(),

  // Pricing
  price: z.string().optional(),
  entityPricing: PricingConfigSchema.nullish().transform((v) => v ?? undefined),

  // Limits
  messageHistoryLimit: z.number().int().default(100),
  maxBodyBytes: z.number().int().default(25 * 1024 * 1024),
});

export type ZyndBaseConfig = z.infer<typeof ZyndBaseConfigSchema>;

export const AgentConfigSchema = ZyndBaseConfigSchema.extend({});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ServiceConfigSchema = ZyndBaseConfigSchema.extend({
  serviceEndpoint: z.string().optional(),
  openapiUrl: z.string().optional(),
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

// -----------------------------------------------------------------------------
// Search / registry types — unchanged
// -----------------------------------------------------------------------------

export interface AgentSearchResponse {
  entity_id: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  capability_summary?: Record<string, unknown>;
  entity_url: string;
  home_registry: string;
  score: number;
  score_breakdown?: Record<string, number>;
  card?: Record<string, unknown>;
  status?: string;
  last_heartbeat?: string;
}

export interface SearchRequest {
  query?: string;
  category?: string;
  tags?: string[];
  skills?: string[];
  protocols?: string[];
  languages?: string[];
  models?: string[];
  min_trust_score?: number;
  status?: string;
  developer_id?: string;
  developer_handle?: string;
  fqan?: string;
  entity_type?: string;
  max_results?: number;
  offset?: number;
  federated?: boolean;
  enrich?: boolean;
  timeout_ms?: number;
}

export interface SearchResult {
  results: AgentSearchResponse[];
  total_found: number;
  offset: number;
  has_more: boolean;
  search_stats?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Local on-disk config file (the .agent/config.json keypair pointer)
// -----------------------------------------------------------------------------

export interface AgentConfigFile {
  schema_version: "2.0";
  entity_id: string;
  public_key: string;
  private_key: string;
  name: string;
  description: string;
  entity_url: string;
  registry_url: string;
  created_at: string;
}

export interface DerivationProof {
  developer_public_key: string;
  entity_index: number;
  developer_signature: string;
}
