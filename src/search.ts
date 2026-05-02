import type { AgentSearchResponse } from "./types.js";
import * as registry from "./registry.js";

export class SearchAndDiscoveryManager {
  private registryUrl: string;

  constructor(registryUrl: string = "https://zns01.zynd.ai") {
    this.registryUrl = registryUrl;
  }

  async searchEntities(opts: {
    keyword?: string;
    category?: string;
    tags?: string[];
    skills?: string[];
    protocols?: string[];
    languages?: string[];
    models?: string[];
    minTrustScore?: number;
    limit?: number;
    federated?: boolean;
    enrich?: boolean;
  }): Promise<AgentSearchResponse[]> {
    const result = await registry.searchEntities({
      registryUrl: this.registryUrl,
      query: {
        query: opts.keyword,
        category: opts.category,
        tags: opts.tags,
        skills: opts.skills,
        protocols: opts.protocols,
        languages: opts.languages,
        models: opts.models,
        min_trust_score: opts.minTrustScore,
        max_results: opts.limit ?? 10,
        federated: opts.federated,
        enrich: opts.enrich,
      },
    });
    return result.results;
  }

  async searchByCapabilities(
    capabilities: string[],
    topK?: number
  ): Promise<AgentSearchResponse[]> {
    return this.searchEntities({
      keyword: capabilities.join(" "),
      skills: capabilities,
      limit: topK ?? 10,
    });
  }

  async searchByKeyword(
    keyword: string,
    limit: number = 10
  ): Promise<AgentSearchResponse[]> {
    return this.searchEntities({ keyword, limit });
  }

  async getAgentById(entityId: string): Promise<Record<string, unknown> | null> {
    return registry.getEntity(this.registryUrl, entityId);
  }

  async getEntityCard(entityId: string): Promise<Record<string, unknown> | null> {
    return registry.getEntityCard(this.registryUrl, entityId);
  }
}
