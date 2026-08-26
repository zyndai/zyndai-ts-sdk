export interface FactDecl {
  predicate: string;
  value: string;
}

export interface CardUpdate {
  capabilities: string[];
  tags: string[];
  summary?: string;
}

export interface DistillResult {
  textBlob: string;
  findabilityFacts: FactDecl[];
  cardEnrichment: CardUpdate;
}

export interface ConnectorHealth {
  connected: boolean;
  rateLimitRemaining?: number;
  cooldownUntil?: Date;
  error?: string;
}

export interface ConnectorConfig {
  [key: string]: unknown;
}

export interface IMemoryConnector {
  readonly name: string;
  connect(config: ConnectorConfig): Promise<void>;
  distill(): Promise<DistillResult>;
  health(): Promise<ConnectorHealth>;
}

export interface SyncResult {
  factsWritten: number;
  factsDeclared: number;
  factsSkipped: number;
  textBytes: number;
  cardUpdated: boolean;
  connectorResults: Record<string, { ok: boolean; error?: string }>;
}

export interface CtxConfig {
  providers: {
    linkedin?: {
      /** Captured via browser login — works with Google OAuth, SSO, etc. */
      li_at: string;
      jsessionid?: string;
    };
    mem0?: {
      api_key: string;
      user_id?: string;
    };
    zep?: {
      url: string;
      api_key: string;
      user_id?: string;
      session_id?: string;
    };
  };
  sync_interval_ms?: number;
  memory_url?: string;
  registry_url?: string;
  /** User UUID in memory-layer — extracted from access_token sub claim on init */
  user_id?: string;
  /** OAuth2 access token (HS256 JWT from memory-layer) */
  access_token?: string;
  /** OAuth2 refresh token — used to renew expired access_token without re-auth */
  refresh_token?: string;
  /** DCR client_id registered with memory-layer — needed for token refresh */
  oauth_client_id?: string;
  /** @deprecated Use access_token instead. Kept for local-dev backwards compat. */
  jwt_secret?: string;
}

export interface MatchResult {
  user_id: string;
  display_name: string;
  similarity: number;
  assertion_count: number;
  socials?: Record<string, string>;
  contact?: string;
  agent_card?: Record<string, unknown>;
}
