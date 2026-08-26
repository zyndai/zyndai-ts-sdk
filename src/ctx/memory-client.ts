import * as crypto from "node:crypto";
import { refreshAccessToken, tokenExpiresAt } from "./oauth.js";
import type { FactDecl, MatchResult } from "./types.js";

export interface MemoryClientConfig {
  baseUrl: string;
  /** OAuth2 access token from memory-layer. Takes priority over jwtSecret. */
  accessToken?: string;
  /** OAuth2 refresh token — used to renew access_token without user interaction. */
  refreshToken?: string;
  /** DCR client_id — required for token refresh. */
  oauthClientId?: string;
  /** Called after a successful token refresh so the caller can persist new tokens. */
  onTokenRefresh?: (accessToken: string, refreshToken: string) => void;
  /** @deprecated Local-dev fallback: sign JWTs locally with a shared secret. */
  jwtSecret?: string;
  /** @deprecated Required when using jwtSecret. */
  userId?: string;
}

// Seconds before expiry to proactively refresh (avoids 401 from clock skew).
const REFRESH_BUFFER_SECONDS = 60;

function makeLocalJwt(userId: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iss: "zynd", typ: "access", iat: now, exp: now + 300 })
  ).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(sigInput).digest("base64url");
  return `${sigInput}.${sig}`;
}

export class MemoryClient {
  private config: MemoryClientConfig;
  private currentAccessToken: string;
  private currentRefreshToken: string | undefined;

  constructor(config: MemoryClientConfig) {
    this.config = config;
    this.currentAccessToken = config.accessToken ?? "";
    this.currentRefreshToken = config.refreshToken;
  }

  private async bearerToken(): Promise<string> {
    if (!this.currentAccessToken && this.config.jwtSecret && this.config.userId) {
      return makeLocalJwt(this.config.userId, this.config.jwtSecret);
    }

    const expiresAt = tokenExpiresAt(this.currentAccessToken);
    const now = Math.floor(Date.now() / 1000);
    const needsRefresh = expiresAt > 0 && expiresAt - now < REFRESH_BUFFER_SECONDS;

    if (needsRefresh && this.currentRefreshToken && this.config.oauthClientId) {
      const refreshed = await refreshAccessToken({
        memoryUrl: this.config.baseUrl,
        clientId: this.config.oauthClientId,
        refreshToken: this.currentRefreshToken,
      });
      this.currentAccessToken = refreshed.accessToken;
      this.currentRefreshToken = refreshed.refreshToken;
      this.config.onTokenRefresh?.(refreshed.accessToken, refreshed.refreshToken);
    }

    return this.currentAccessToken;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async fetchJson<T>(path: string, options: RequestInit): Promise<T> {
    const token = await this.bearerToken();
    const resp = await fetch(this.url(path), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`memory-layer ${resp.status} ${path}: ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  async ingestText(text: string): Promise<{ chunks_inserted: number; chunks_skipped: number }> {
    if (text.length < 40) {
      return { chunks_inserted: 0, chunks_skipped: 1 };
    }
    return this.fetchJson("/ingest", {
      method: "POST",
      body: JSON.stringify({
        source_system: "zynd_ctx",
        turns: [{ role: "user", content: text }],
      }),
    });
  }

  async declareBatch(
    facts: FactDecl[]
  ): Promise<{ declared: FactDecl[]; skipped: Array<FactDecl & { reason: string }> }> {
    if (facts.length === 0) {
      return { declared: [], skipped: [] };
    }
    return this.fetchJson("/me/findability/declare-batch", {
      method: "POST",
      body: JSON.stringify({ declarations: facts.slice(0, 50) }),
    });
  }

  async getMatches(
    clusterType: "full_context" | "skill_cluster" | "intent_cluster" | "place_cluster" = "full_context",
    limit = 20
  ): Promise<MatchResult[]> {
    const userId = this.config.userId ?? "";
    return this.fetchJson(`/match/${userId}?cluster=${clusterType}&limit=${limit}`, {
      method: "GET",
    });
  }

  async getCard(): Promise<Array<{ predicate: string; object: string; confidence: number }>> {
    return this.fetchJson("/me/findability", { method: "GET" });
  }

  async getSuggestions(): Promise<Array<{ id: string; predicate: string; object: string; confidence: number }>> {
    return this.fetchJson("/me/findability/suggestions", { method: "GET" });
  }

  async approveSuggestion(predicate: string, object: string): Promise<void> {
    await this.fetchJson("/me/findability/approve", {
      method: "POST",
      body: JSON.stringify({ predicate, object }),
    });
  }
}
