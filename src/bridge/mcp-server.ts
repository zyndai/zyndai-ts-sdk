import * as http from "node:http";
import * as crypto from "node:crypto";
import { loadStore, saveStore } from "./store.js";
import { getGovernorStatus } from "./linkedin-governor.js";
import type { PrivacyTier } from "./distiller.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface McpServerOptions {
  port?: number;
  /** Bearer token — generated randomly if not provided */
  token?: string;
  memoryUrl?: string;
  authToken?: string;
}

export interface McpServer {
  port: number;
  token: string;
  stop(): Promise<void>;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "zynd_bridge_status",
    description: "Returns bridge daemon status: uptime, adapter states, outbox depth.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "zynd_persona_preview",
    description: "Preview your redacted persona assertions at the specified privacy tier.",
    inputSchema: {
      type: "object",
      properties: {
        tier: { type: "number", enum: [0, 1, 2], description: "Privacy tier: 0=public card, 1=discovery, 2=gated" },
      },
      required: ["tier"],
    },
  },
  {
    name: "zynd_context_sync",
    description: "Trigger a context sync from all configured sources.",
    inputSchema: {
      type: "object",
      properties: {
        sources: { type: "array", items: { type: "string" }, description: "Sources to sync (default: all)" },
      },
      required: [],
    },
  },
  {
    name: "zynd_linkedin_status",
    description: "Returns LinkedIn sidecar health, cooldown expiry, and rate quota.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "zynd_match_search",
    description: "Find similar people in the Zynd network based on your context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "zynd_remember",
    description:
      "Store a local-only capability note. NOTE: persists strictly to local encrypted store — does NOT auto-sync to cloud (blocked gate, min 40 chars).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Capability note to remember (min 40 chars)" },
      },
      required: ["content"],
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

const startTime = Date.now();

async function handleTool(
  name: string,
  args: Record<string, unknown>,
  opts: McpServerOptions
): Promise<unknown> {
  switch (name) {
    case "zynd_bridge_status": {
      const store = await loadStore();
      return {
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        outbox_depth: store.outbox.length,
        assertion_count: store.assertions.length,
        local_memory_count: store.localMemories.length,
        linkedin_enabled: true,
      };
    }

    case "zynd_persona_preview": {
      const tier = args["tier"] as PrivacyTier;
      if (tier === undefined || ![0, 1, 2].includes(tier as number)) {
        throw new Error("tier must be 0, 1, or 2");
      }
      const store = await loadStore();
      const preview = store.assertions
        .filter((a) => a.tier <= tier)
        .map((a) => ({ predicate: a.predicate, object: a.object, tier: a.tier }));
      return { tier, assertion_count: preview.length, assertions: preview };
    }

    case "zynd_context_sync": {
      // Lightweight — signal sync needed; actual sync runs via CLI
      return { status: "sync_requested", message: 'Run "zynd bridge sync" to pull now.' };
    }

    case "zynd_linkedin_status": {
      const status = await getGovernorStatus();
      return {
        enabled: status.enabled,
        blocked: status.blocked,
        hour_remaining: status.hourRemaining,
        day_remaining: status.dayRemaining,
        cooldown_until: status.cooldownUntil?.toISOString() ?? null,
      };
    }

    case "zynd_match_search": {
      const query = args["query"] as string;
      const limit = (args["limit"] as number | undefined) ?? 10;
      if (!query?.trim()) throw new Error("query is required");

      if (!opts.memoryUrl || !opts.authToken) {
        return { error: "memory-layer not configured — run zynd bridge init" };
      }

      const resp = await fetch(
        `${opts.memoryUrl}/match/search?q=${encodeURIComponent(query)}&limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${opts.authToken}` },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!resp.ok) throw new Error(`memory-layer ${resp.status}`);
      return resp.json();
    }

    case "zynd_remember": {
      const content = args["content"] as string;
      if (!content || content.trim().length < 40) {
        throw new Error("content must be at least 40 characters for future sync compatibility");
      }
      const store = await loadStore();
      store.localMemories.push({
        id: crypto.randomUUID(),
        content: content.trim(),
        createdAt: Date.now(),
      });
      await saveStore(store);
      return { status: "stored", local_only: true, note: "Does not auto-sync to cloud (blocked gate)." };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC 2.0 dispatcher ──────────────────────────────────────────────────

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

async function handleJsonRpc(
  body: string,
  opts: McpServerOptions
): Promise<string> {
  let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(body) as typeof req;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const { id, method, params } = req;

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const toolName = (params?.["name"] as string | undefined) ?? "";
    const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
    try {
      const result = await handleTool(toolName, args, opts);
      return jsonRpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (err) {
      return jsonRpcError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export function startMcpServer(opts: McpServerOptions = {}): Promise<McpServer> {
  const token = opts.token ?? crypto.randomBytes(16).toString("hex");
  const port = opts.port ?? 0; // 0 = OS assigns available port

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // DNS rebinding protection: validate Host is loopback
      const host = (req.headers["host"] ?? "").split(":")[0] ?? "";
      if (!LOOPBACK_HOSTS.has(host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: non-loopback host" }));
        return;
      }

      // Bearer token authentication
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          const response = await handleJsonRpc(body, opts);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(response);
        } catch (err) {
          res.writeHead(500);
          res.end(jsonRpcError(null, -32603, err instanceof Error ? err.message : String(err)));
        }
      });
    });

    server.on("error", reject);

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;

      resolve({
        port: actualPort,
        token,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
