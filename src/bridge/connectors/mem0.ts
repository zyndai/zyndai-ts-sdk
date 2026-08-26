/**
 * mem0 connector — reads the user's memories via mem0 REST API.
 * Lazy: only activated when api_key is configured.
 * Privacy: raw memory content is distilled to text + structured facts;
 * raw content is never stored locally.
 */
import type { ConnectorConfig, ConnectorHealth, DistillResult, IMemoryConnector } from "../types.js";

const MEM0_BASE = "https://api.mem0.ai/v1";

export class Mem0Connector implements IMemoryConnector {
  readonly name = "mem0";

  private apiKey: string | null = null;
  private userId: string | null = null;

  async connect(config: ConnectorConfig): Promise<void> {
    const key = config["api_key"];
    if (!key || typeof key !== "string") {
      throw new Error("mem0 connector requires api_key in config");
    }
    this.apiKey = key;
    this.userId = typeof config["user_id"] === "string" ? config["user_id"] : "default";
  }

  async health(): Promise<ConnectorHealth> {
    if (!this.apiKey) return { connected: false, error: "not configured" };
    try {
      const resp = await fetch(`${MEM0_BASE}/memories/?user_id=${this.userId}&limit=1`, {
        headers: { Authorization: `Token ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { connected: resp.ok };
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async distill(): Promise<DistillResult> {
    const empty: DistillResult = {
      textBlob: "",
      findabilityFacts: [],
      cardEnrichment: { capabilities: [], tags: [] },
    };
    if (!this.apiKey) return empty;

    let memories: Array<{ memory: string }>;
    try {
      const resp = await fetch(
        `${MEM0_BASE}/memories/?user_id=${this.userId}&limit=30`,
        {
          headers: { Authorization: `Token ${this.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!resp.ok) throw new Error(`mem0 ${resp.status}`);
      const data = (await resp.json()) as { results?: Array<{ memory: string }> } | Array<{ memory: string }>;
      memories = Array.isArray(data) ? data : (data.results ?? []);
    } catch (err) {
      throw new Error(`mem0 fetch failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    const texts = memories
      .map((m) => (m.memory ?? "").trim())
      .filter((t) => t.length >= 10);

    if (texts.length === 0) return empty;

    // Send raw text to /ingest — the memory-layer's DeepSeek pipeline extracts
    // structured assertions server-side (much higher quality than local regex).
    return {
      textBlob: texts.join(". "),
      findabilityFacts: [],
      cardEnrichment: { capabilities: [], tags: [] },
    };
  }
}
