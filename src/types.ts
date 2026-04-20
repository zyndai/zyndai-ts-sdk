import { z } from "zod";

export enum AgentFramework {
  LANGCHAIN = "langchain",
  LANGGRAPH = "langgraph",
  CUSTOM = "custom",
  VERCEL_AI = "vercel_ai",
}

export const ZyndBaseConfigSchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  capabilities: z.record(z.unknown()).optional(),
  autoReconnect: z.boolean().default(true),
  messageHistoryLimit: z.number().int().default(100),
  registryUrl: z.string().default("https://registry.zynd.ai"),
  webhookHost: z.string().default("0.0.0.0"),
  webhookPort: z.number().int().default(5000),
  entityUrl: z.string().optional(),
  webhookUrl: z.string().optional(),
  category: z.string().default("general"),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  useNgrok: z.boolean().default(false),
  ngrokAuthToken: z.string().optional(),
  price: z.string().optional(),
  entityPricing: z
    .object({
      base_price_usd: z.number(),
      currency: z.string().default("USDC"),
    })
    .optional(),
  keypairPath: z.string().optional(),
  configDir: z.string().optional(),
  cardOutput: z.string().optional(),
});

export type ZyndBaseConfig = z.infer<typeof ZyndBaseConfigSchema>;

export const AgentConfigSchema = ZyndBaseConfigSchema.extend({
  developerKeypairPath: z.string().optional(),
  entityIndex: z.number().int().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ServiceConfigSchema = ZyndBaseConfigSchema.extend({
  serviceEndpoint: z.string().optional(),
  openapiUrl: z.string().optional(),
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

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

export interface EntityEndpoints {
  invoke: string;
  invoke_async: string;
  health: string;
  agent_card: string;
}

export interface EntityCardPricing {
  model: string;
  currency: string;
  rates: Record<string, number>;
  payment_methods: string[];
}

export interface EntityCard {
  entity_id: string;
  name: string;
  description: string;
  public_key: string;
  entity_url: string;
  version: string;
  status: string;
  capabilities: Array<{ name: string; category: string }>;
  endpoints: EntityEndpoints;
  pricing?: EntityCardPricing;
  category?: string;
  tags?: string[];
  summary?: string;
  last_heartbeat: string;
  signed_at: string;
  signature?: string;
}

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
