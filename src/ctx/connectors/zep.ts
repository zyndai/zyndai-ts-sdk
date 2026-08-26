/**
 * Zep connector — reads memory context from Zep Cloud.
 *
 * Data path:
 *   thread.getUserContext(threadId) → rich context string (episodes + facts + summary)
 *   Fallback: zep.user.getThreads(userId) → latest thread → getUserContext
 *
 * Requires: url + api_key. Optional: user_id, session_id.
 */
import type { ConnectorConfig, ConnectorHealth, DistillResult, IMemoryConnector } from "../types.js";

export class ZepConnector implements IMemoryConnector {
  readonly name = "zep";

  private apiKey: string | null = null;
  private userId: string | null = null;
  private sessionId: string | null = null;

  async connect(config: ConnectorConfig): Promise<void> {
    const key = config["api_key"];
    if (!key || typeof key !== "string") throw new Error("zep connector requires api_key");
    this.apiKey = key;
    this.userId = typeof config["user_id"] === "string" ? config["user_id"] : null;
    this.sessionId = typeof config["session_id"] === "string" ? config["session_id"] : null;
  }

  async health(): Promise<ConnectorHealth> {
    if (!this.apiKey) return { connected: false, error: "not configured" };
    try {
      const { ZepClient } = await import("@getzep/zep-cloud");
      const zep = new ZepClient({ apiKey: this.apiKey });
      // Warm call to verify credentials — throws on 401/403
      await zep.user.get(this.userId ?? "healthcheck-probe").catch((e: unknown) => {
        // 404 = user not found = valid credentials; anything else = error
        const status = (e as { statusCode?: number })?.statusCode;
        if (status !== 404) throw e;
      });
      return { connected: true };
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

    const { ZepClient } = await import("@getzep/zep-cloud");
    const zep = new ZepClient({ apiKey: this.apiKey });

    // Resolve the thread ID to query
    let threadId = this.sessionId ?? null;
    if (!threadId && this.userId) {
      threadId = await this.resolveLatestThreadId(zep, this.userId);
    }
    if (!threadId) return empty;

    try {
      const ctx = await zep.thread.getUserContext(threadId);
      const text = typeof ctx.context === "string" ? ctx.context.trim() : "";
      if (!text || text.length < 20) return empty;
      return {
        textBlob: text,
        findabilityFacts: [],
        cardEnrichment: { capabilities: [], tags: [] },
      };
    } catch (err) {
      throw new Error(
        `zep fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private async resolveLatestThreadId(
    zep: import("@getzep/zep-cloud").ZepClient,
    userId: string,
  ): Promise<string | null> {
    try {
      const threads = await zep.user.getThreads(userId);
      const list = Array.isArray(threads) ? threads : (threads as { threads?: unknown[] })?.threads ?? [];
      if (list.length === 0) return null;
      const sorted = [...list].sort((a, b) => {
        const at = new Date((a as { createdAt?: string }).createdAt ?? 0).getTime();
        const bt = new Date((b as { createdAt?: string }).createdAt ?? 0).getTime();
        return bt - at;
      });
      return (sorted[0] as { threadId?: string }).threadId ?? null;
    } catch {
      return null;
    }
  }
}
