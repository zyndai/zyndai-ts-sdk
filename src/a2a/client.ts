/**
 * Outbound A2A client.
 *
 * Three transport modes:
 *   - sync()    → message/send, returns the final Task
 *   - stream()  → message/stream, async iterator over StreamEvent
 *   - call()    → unified entry that picks based on the agent's card
 *
 * Every outbound message is signed with x-zynd-auth so the receiver can
 * verify it's coming from a Zynd peer.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MessageSchema } from "./types.js";
import type {
  ATask,
  Message,
  Part,
  StreamEvent,
  JsonRpcResponse,
  JsonRpcError,
} from "./types.js";
import { signMessage, type SignOptions } from "./auth.js";
import { toA2AMessage, taskReplyText, type Attachment } from "./adapter.js";
import type { Ed25519Keypair } from "../identity.js";

export interface ClientOptions {
  keypair: Ed25519Keypair;
  entityId: string;
  fqan?: string;
  developerProof?: import("./types.js").ZyndAuth["developer_proof"];
}

export interface CallOptions {
  /** A2A endpoint URL — usually the agent card's `url` or the well-known
   *  agent's `/a2a/v1`. */
  url: string;
  /** Free-form text part. */
  text?: string;
  /** Structured DataPart payload. */
  data?: Record<string, unknown>;
  /** File attachments. */
  attachments?: Attachment[];
  /** Continuation: same task. */
  taskId?: string;
  /** Continuation: same conversation. */
  contextId?: string;
  /** Override blocking config; default true (server returns final state). */
  blocking?: boolean;
  /** Per-call timeout in ms. Default 5 min. */
  timeoutMs?: number;
}

export class A2AClient {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  /** Synchronous request — returns the final Task (or throws). */
  async sync(callOpts: CallOptions): Promise<ATask> {
    const message = this.buildMessage(callOpts);
    const rpc = {
      jsonrpc: "2.0" as const,
      id: randomUUID(),
      method: "message/send",
      params: { message, configuration: { blocking: callOpts.blocking ?? true } },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), callOpts.timeoutMs ?? 5 * 60 * 1000);

    let resp: globalThis.Response;
    try {
      resp = await fetch(callOpts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpc),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "(unreadable)");
      throw new Error(`A2A sync HTTP ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as JsonRpcResponse<ATask | Message>;
    if ("error" in json) throw new A2AError(json);

    const result = json.result;
    if (result && typeof result === "object" && "kind" in result && result.kind === "task") {
      return result as ATask;
    }
    // The server might also return a bare Message (when no task was created
    // and the response is a one-shot). Wrap it in a synthetic completed Task
    // so callers always see a uniform shape.
    return {
      kind: "task",
      id: randomUUID(),
      contextId: callOpts.contextId ?? randomUUID(),
      status: { state: "completed" },
      history: [result as Message],
      artifacts: [],
    };
  }

  /** Streaming request — yields StreamEvents until the server closes. */
  async *stream(callOpts: CallOptions): AsyncGenerator<StreamEvent> {
    const message = this.buildMessage(callOpts);
    const rpc = {
      jsonrpc: "2.0" as const,
      id: randomUUID(),
      method: "message/stream",
      params: { message },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), callOpts.timeoutMs ?? 30 * 60 * 1000);

    let resp: globalThis.Response;
    try {
      resp = await fetch(callOpts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(rpc),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      const body = await resp.text().catch(() => "(unreadable)");
      throw new Error(`A2A stream HTTP ${resp.status}: ${body}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames. A frame is `data: <json>\n\n`.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as JsonRpcResponse<StreamEvent>;
              if ("error" in parsed) throw new A2AError(parsed);
              const ev = parsed.result;
              if (ev) yield ev;
              if (
                ev &&
                "kind" in ev &&
                ev.kind === "status-update" &&
                "final" in ev &&
                ev.final
              ) {
                return;
              }
            } catch (err) {
              if (err instanceof A2AError) throw err;
              console.error("[a2a-client] failed to parse SSE frame:", err);
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  /** Resolve an agent card URL → its A2A endpoint, then sync(). */
  async callViaCard(cardUrl: string, callOpts: Omit<CallOptions, "url">): Promise<ATask> {
    const endpoint = await resolveA2AEndpoint(cardUrl);
    return this.sync({ ...callOpts, url: endpoint });
  }

  /**
   * Convenience: call another agent and return its reply text directly.
   *
   * This is the right method to use from inside an LLM tool. It encapsulates
   * the (sync → read artifacts → join text/data parts) sequence so callers
   * don't accidentally read task.history[last] (which is their own outbound
   * message echoed back, causing the LLM to loop on the tool).
   *
   * Accepts either an A2A endpoint URL (will be called directly) or a card
   * URL / base URL (resolved to the A2A endpoint via /.well-known/agent-card.json).
   */
  async ask(
    target: string,
    text: string,
    opts: Omit<CallOptions, "url" | "text"> = {},
  ): Promise<string> {
    // Heuristic: ".json" or "/.well-known/" → card URL; everything else
    // we treat as a card-or-base URL and let callViaCard normalize it.
    // If the caller passed a true A2A endpoint URL (ends in /a2a/v1) we
    // also go through callViaCard which fetches the card and reads the
    // canonical `url` field — that's the spec-compliant behavior.
    const task = target.includes("/a2a/")
      ? await this.sync({ ...opts, url: target, text })
      : await this.callViaCard(target, { ...opts, text });
    return taskReplyText(task);
  }

  // ---------------------------------------------------------------------------

  private buildMessage(opts: CallOptions): Message {
    const msg = toA2AMessage({
      role: "user",
      messageId: randomUUID(),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.data ? { data: opts.data } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    });
    const signOpts: SignOptions = {
      keypair: this.opts.keypair,
      entityId: this.opts.entityId,
      ...(this.opts.fqan ? { fqan: this.opts.fqan } : {}),
      ...(this.opts.developerProof ? { developerProof: this.opts.developerProof } : {}),
    };
    signMessage(msg, signOpts);
    // Belt-and-suspenders: validate the shape we're shipping.
    MessageSchema.parse(msg);
    return msg;
  }
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class A2AError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(rpc: JsonRpcError) {
    super(`A2A error ${rpc.error.code}: ${rpc.error.message}`);
    this.name = "A2AError";
    this.code = rpc.error.code;
    this.data = rpc.error.data;
  }
}

// -----------------------------------------------------------------------------
// Card discovery helpers
// -----------------------------------------------------------------------------

const AgentCardEndpointSchema = z.object({
  url: z.string().optional(),
  preferredTransport: z.string().optional(),
  additionalInterfaces: z
    .array(
      z.object({
        transport: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
});

/** Fetch the agent card and return its primary A2A JSON-RPC URL. */
export async function resolveA2AEndpoint(cardUrl: string): Promise<string> {
  const normalized = cardUrl.endsWith(".json")
    ? cardUrl
    : `${cardUrl.replace(/\/+$/, "")}/.well-known/agent-card.json`;

  const resp = await fetch(normalized, { method: "GET" });
  if (!resp.ok) throw new Error(`agent-card fetch HTTP ${resp.status}: ${normalized}`);
  const card = await resp.json();
  const parsed = AgentCardEndpointSchema.safeParse(card);
  if (!parsed.success) throw new Error("agent card missing required transport fields");

  const data = parsed.data;
  const preferred = (data.preferredTransport ?? "JSONRPC").toUpperCase();
  if (data.url && (preferred === "JSONRPC" || preferred === "")) return data.url;
  for (const iface of data.additionalInterfaces ?? []) {
    if (iface.transport.toUpperCase() === "JSONRPC") return iface.url;
  }
  if (data.url) return data.url;
  throw new Error("no JSON-RPC endpoint advertised on agent card");
}
