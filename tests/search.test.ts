import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SearchAndDiscoveryManager } from "../src/search";
import type { AgentSearchResponse } from "../src/types";

const REGISTRY = "https://registry.example.com";

function makeSearchResponse(results: AgentSearchResponse[]): unknown {
  return {
    results,
    total_found: results.length,
    offset: 0,
    has_more: false,
  };
}

function mockFetchOnce(body: unknown, status = 200): void {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(response);
}

function makeAgent(id: string): AgentSearchResponse {
  return {
    entity_id: id,
    name: `agent-${id}`,
    summary: "test",
    category: "general",
    tags: [],
    entity_url: `https://${id}.example.com`,
    home_registry: REGISTRY,
    score: 0.9,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SearchAndDiscoveryManager", () => {
  describe("constructor", () => {
    it("defaults to the production registry URL", async () => {
      const mgr = new SearchAndDiscoveryManager();
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByKeyword("x");

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
      expect(url).toBe("https://dns01.zynd.ai/v1/search");
    });

    it("accepts a custom registry URL", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));
      await mgr.searchByKeyword("x");
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
      expect(url).toBe(`${REGISTRY}/v1/search`);
    });
  });

  describe("searchEntities", () => {
    it("returns the results array from the registry response", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      const agents = [makeAgent("zns:a"), makeAgent("zns:b")];
      mockFetchOnce(makeSearchResponse(agents));

      const results = await mgr.searchEntities({ keyword: "weather" });

      expect(results).toEqual(agents);
    });

    it("maps keyword to query field in the request body", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchEntities({ keyword: "translator" });

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["query"]).toBe("translator");
    });

    it("maps minTrustScore to min_trust_score in the request body", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchEntities({ minTrustScore: 0.8 });

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["min_trust_score"]).toBe(0.8);
    });

    it("defaults max_results to 10 when limit is omitted", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchEntities({});

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["max_results"]).toBe(10);
    });

    it("forwards all optional filter fields to the request body", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchEntities({
        category: "finance",
        tags: ["defi"],
        skills: ["swap"],
        protocols: ["uniswap"],
        languages: ["en"],
        models: ["gpt-4"],
        limit: 5,
        federated: true,
        enrich: true,
      });

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["category"]).toBe("finance");
      expect(sent["tags"]).toEqual(["defi"]);
      expect(sent["skills"]).toEqual(["swap"]);
      expect(sent["protocols"]).toEqual(["uniswap"]);
      expect(sent["languages"]).toEqual(["en"]);
      expect(sent["models"]).toEqual(["gpt-4"]);
      expect(sent["max_results"]).toBe(5);
      expect(sent["federated"]).toBe(true);
      expect(sent["enrich"]).toBe(true);
    });

    it("propagates registry errors", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("bad request", { status: 400 })
      );

      await expect(mgr.searchEntities({ keyword: "x" })).rejects.toThrow("HTTP 400");
    });
  });

  describe("searchByCapabilities", () => {
    it("joins capabilities as keyword and passes them as skills", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByCapabilities(["translate", "summarize"]);

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["query"]).toBe("translate summarize");
      expect(sent["skills"]).toEqual(["translate", "summarize"]);
    });

    it("defaults topK to 10", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByCapabilities(["code"]);

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["max_results"]).toBe(10);
    });

    it("forwards topK as max_results", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByCapabilities(["research"], 3);

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["max_results"]).toBe(3);
    });

    it("returns the results array", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      const agents = [makeAgent("zns:cap")];
      mockFetchOnce(makeSearchResponse(agents));

      const results = await mgr.searchByCapabilities(["weather"]);
      expect(results).toEqual(agents);
    });
  });

  describe("searchByKeyword", () => {
    it("passes keyword as query field", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByKeyword("stock price");

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["query"]).toBe("stock price");
    });

    it("defaults limit to 10", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByKeyword("news");

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["max_results"]).toBe(10);
    });

    it("forwards explicit limit as max_results", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      mockFetchOnce(makeSearchResponse([]));

      await mgr.searchByKeyword("coder", 20);

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sent["max_results"]).toBe(20);
    });

    it("returns the results array", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      const agents = [makeAgent("zns:kw")];
      mockFetchOnce(makeSearchResponse(agents));

      const results = await mgr.searchByKeyword("weather");
      expect(results).toEqual(agents);
    });
  });

  describe("getAgentById", () => {
    it("fetches /v1/entities/{id} and returns the record", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      const entity = { entity_id: "zns:abc", name: "bot" };
      mockFetchOnce(entity);

      const result = await mgr.getAgentById("zns:abc");

      expect(result).toEqual(entity);
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
      expect(url).toBe(`${REGISTRY}/v1/entities/zns%3Aabc`);
    });

    it("returns null on 404", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("{}", { status: 404 })
      );

      const result = await mgr.getAgentById("zns:missing");
      expect(result).toBeNull();
    });
  });

  describe("getEntityCard", () => {
    it("fetches /v1/entities/{id}/card and returns the record", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      const card = { entity_id: "zns:abc", name: "agent" };
      mockFetchOnce(card);

      const result = await mgr.getEntityCard("zns:abc");

      expect(result).toEqual(card);
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
      expect(url).toBe(`${REGISTRY}/v1/entities/zns%3Aabc/card`);
    });

    it("returns null on 404", async () => {
      const mgr = new SearchAndDiscoveryManager(REGISTRY);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("{}", { status: 404 })
      );

      const result = await mgr.getEntityCard("zns:missing");
      expect(result).toBeNull();
    });
  });
});
