/**
 * ZyndNative connector — reads the user's own memory-layer assertions
 * via the /me/findability endpoint to reflect what's already in the graph.
 * Primarily used to enrich the AgentDNS card without re-syncing.
 */
import type { ConnectorConfig, ConnectorHealth, DistillResult, IMemoryConnector } from "../types.js";
import type { MemoryClient } from "../memory-client.js";

export class ZyndNativeConnector implements IMemoryConnector {
  readonly name = "zynd_native";
  private client: MemoryClient | null = null;

  async connect(config: ConnectorConfig): Promise<void> {
    const client = config["_memoryClient"];
    if (!client) throw new Error("zynd_native requires _memoryClient in config");
    this.client = client as MemoryClient;
  }

  async health(): Promise<ConnectorHealth> {
    return { connected: this.client !== null };
  }

  async distill(): Promise<DistillResult> {
    const empty: DistillResult = {
      textBlob: "",
      findabilityFacts: [],
      cardEnrichment: { capabilities: [], tags: [] },
    };
    if (!this.client) return empty;

    let card: Array<{ predicate: string; object: string; confidence: number }>;
    try {
      card = await this.client.getCard();
    } catch {
      return empty;
    }

    const capabilities = card
      .filter((f) => f.predicate === "has_expertise_in" && f.confidence > 0.5)
      .map((f) => f.object);
    const tags = capabilities.map((c) => c.toLowerCase().replace(/\s+/g, "-"));

    return {
      textBlob: "",  // already in memory-layer, no need to re-ingest
      findabilityFacts: [],  // already declared, no need to re-declare
      cardEnrichment: { capabilities, tags },
    };
  }
}
