import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type Application } from "express";
import { z } from "zod";
import { AgentMessage } from "./message.js";
import type { Ed25519Keypair } from "./identity.js";
import type { AgentSearchResponse } from "./types.js";

export type MessageHandler = (message: AgentMessage, topic: string | null) => void | Promise<void>;

/** Default body-size limit for /webhook and /webhook/sync when none is configured. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB

export interface WebhookOptions {
  entityId: string;
  webhookHost?: string;
  webhookPort?: number;
  webhookUrl?: string;
  keypair?: Ed25519Keypair;
  agentCardBuilder?: () => Record<string, unknown>;
  price?: string;
  payToAddress?: string;
  messageHistoryLimit?: number;
  /**
   * Zod schema the webhook validates every incoming request body against
   * before firing handlers. On mismatch, callers get 400 + flattened errors.
   * Leave undefined to accept any JSON body (back-compat).
   */
  payloadModel?: z.ZodTypeAny;
  /**
   * Zod schema setResponse() validates the handler's output against before
   * caching it. On mismatch, setResponse throws — this is a handler bug, not
   * a caller error, so we surface it to the developer immediately.
   */
  outputModel?: z.ZodTypeAny;
  /**
   * Cap on the /webhook and /webhook/sync request body size. Bounds inline
   * base64 attachments before Express rejects with 413. Defaults to 25 MiB,
   * matching `MAX_FILE_SIZE_BYTES` in payload.ts.tpl.
   */
  maxFileSizeBytes?: number;
}

// How long the sync handler waits for setResponse before returning 408.
const SYNC_TIMEOUT_MS = 30_000;
// Polling interval while waiting for a sync response.
const SYNC_POLL_INTERVAL_MS = 50;

export class WebhookCommunicationManager {
  private readonly entityId: string;
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly explicitWebhookUrl: string | undefined;
  private readonly agentCardBuilder: (() => Record<string, unknown>) | undefined;
  private readonly messageHistoryLimit: number;
  private readonly payloadModel: z.ZodTypeAny | undefined;
  private readonly outputModel: z.ZodTypeAny | undefined;
  private readonly maxFileSizeBytes: number;

  private readonly handlers: MessageHandler[] = [];
  // messageId -> resolved response string (set by setResponse)
  private readonly pendingResponses = new Map<string, string>();
  private readonly receivedMessages: Array<{ message: AgentMessage; receivedAt: number }> = [];
  private readonly messageHistory: Array<{ message: AgentMessage; receivedAt: number }> = [];

  private app: Application;
  private server: Server | null = null;
  private _port = 0;
  private _isRunning = false;

  constructor(opts: WebhookOptions) {
    this.entityId = opts.entityId;
    this.host = opts.webhookHost ?? "0.0.0.0";
    this.desiredPort = opts.webhookPort ?? 5000;
    this.explicitWebhookUrl = opts.webhookUrl;
    this.agentCardBuilder = opts.agentCardBuilder;
    this.messageHistoryLimit = opts.messageHistoryLimit ?? 100;
    this.payloadModel = opts.payloadModel;
    this.outputModel = opts.outputModel;
    this.maxFileSizeBytes = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

    this.app = express();
    // Bump the default 100kb limit so inline base64 attachments actually fit.
    this.app.use(express.json({ limit: this.maxFileSizeBytes }));
    this.registerRoutes();
    this.registerErrorHandler();
  }

  get port(): number {
    return this._port;
  }

  get webhookUrl(): string {
    if (this.explicitWebhookUrl) return this.explicitWebhookUrl;
    return `http://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${this._port}`;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  addMessageHandler(fn: MessageHandler): void {
    this.handlers.push(fn);
  }

  registerHandler(fn: MessageHandler): void {
    this.addMessageHandler(fn);
  }

  /**
   * Store the handler's result for a given message. Called by the user's
   * message handler once it finishes producing a reply.
   *
   * Validation policy mirrors the Python SDK's `set_response`:
   *   - string: stored verbatim, no validation. Templates that return raw
   *     text from `agent.invoke` flow through unchanged.
   *   - object: validated against `outputModel` if configured. On failure,
   *     stores an error JSON instead of throwing — the webhook handler is
   *     still waiting on this slot, so we don't want to crash it.
   */
  setResponse(messageId: string, response: unknown): void {
    let stored: string;
    if (typeof response === "string") {
      stored = response;
    } else if (this.outputModel) {
      const result = this.outputModel.safeParse(response);
      if (!result.success) {
        const detail = result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        stored = JSON.stringify({
          error: "handler_output_invalid",
          details: detail,
        });
      } else {
        stored = JSON.stringify(result.data);
      }
    } else {
      stored = JSON.stringify(response);
    }
    this.pendingResponses.set(messageId, stored);
  }

  async start(): Promise<void> {
    // Fail fast on EADDRINUSE — no retry loop.
    //
    // This mirrors the behavior change in the Python SDK (commit 04ce77f):
    // the previous "try port N, N+1, N+2 ..." fallback was surprising — an
    // agent configured for port 5000 could silently end up on 5007, breaking
    // the URL the user advertised. The new contract is: the port you
    // configure is the port you get; if it's busy, that's an error to fix,
    // not to paper over.
    await this.tryListen(this.desiredPort);
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(this.app);

      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Cannot start webhook server: port ${port} on ${this.host} is already in use. ` +
                `Stop the process using it or configure a different webhookPort.`,
              { cause: err },
            ),
          );
          return;
        }
        reject(
          new Error(
            `WebhookCommunicationManager: server failed to start on port ${port}: ${err.message}`,
            { cause: err },
          ),
        );
      });

      server.listen(port, this.host, () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          reject(
            new Error(
              "WebhookCommunicationManager: unexpected server address type",
            ),
          );
          return;
        }
        this.server = server;
        this._port = addr.port;
        this._isRunning = true;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          reject(new Error(`WebhookCommunicationManager: error closing server: ${err.message}`, { cause: err }));
          return;
        }
        this._isRunning = false;
        resolve();
      });
    });
  }

  // Sends an AgentMessage to targetUrl and returns the response body as a string.
  async sendMessage(
    targetUrl: string,
    content: string,
    opts?: { receiverId?: string; messageType?: string; metadata?: Record<string, unknown> }
  ): Promise<string> {
    const message = new AgentMessage({
      content,
      senderId: this.entityId,
      receiverId: opts?.receiverId,
      messageType: opts?.messageType ?? "query",
      metadata: opts?.metadata,
    });

    let resp: globalThis.Response;
    try {
      resp = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: message.toJson(),
      });
    } catch (err) {
      throw new Error(`sendMessage: network error to ${targetUrl}: ${String(err)}`, { cause: err });
    }

    const text = await resp.text().catch(() => "(unreadable)");
    if (!resp.ok) {
      throw new Error(`sendMessage: HTTP ${resp.status} from ${targetUrl}: ${text}`);
    }
    return text;
  }

  // Resolves the invoke URL for an agent: prefers card endpoints.invoke, falls back to entity_url/webhook.
  connectAgent(agent: AgentSearchResponse): string {
    const card = agent.card as Record<string, unknown> | undefined;
    const endpoints = card?.["endpoints"] as Record<string, string> | undefined;
    if (endpoints?.["invoke"]) return endpoints["invoke"];
    return `${agent.entity_url.replace(/\/+$/, "")}/webhook/sync`;
  }

  readMessages(): string {
    if (!this._isRunning) return "Webhook server not running.";
    if (this.receivedMessages.length === 0) return "No new messages in the queue.";

    const formatted = this.receivedMessages.map((item) => {
      const m = item.message;
      return `From: ${m.senderId}\nType: ${m.messageType}\nContent: ${m.content}`;
    });

    const output = "Messages received:\n\n" + formatted.join("\n---\n");
    this.receivedMessages.length = 0;
    return output;
  }

  getConnectionStatus(): {
    entity_id: string;
    is_running: boolean;
    webhook_url: string;
    webhook_port: number;
    pending_messages: number;
    message_history_count: number;
  } {
    return {
      entity_id: this.entityId,
      is_running: this._isRunning,
      webhook_url: this.webhookUrl,
      webhook_port: this._port,
      pending_messages: this.receivedMessages.length,
      message_history_count: this.messageHistory.length,
    };
  }

  getMessageHistory(limit?: number): Array<{ message: AgentMessage; receivedAt: number }> {
    if (limit === undefined) return [...this.messageHistory];
    return this.messageHistory.slice(-limit);
  }

  private registerRoutes(): void {
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({ status: "ok", entity_id: this.entityId, timestamp: new Date().toISOString() });
    });

    this.app.get("/.well-known/agent.json", (_req: Request, res: Response) => {
      if (!this.agentCardBuilder) {
        res.status(404).json({ error: "agent card not configured" });
        return;
      }
      res.json(this.agentCardBuilder());
    });

    this.app.post("/webhook", (req: Request, res: Response) => {
      if (!isJsonContentType(req)) {
        res.status(400).json({ error: "Content-Type must be application/json" });
        return;
      }

      const parseResult = this.validatePayload(req.body);
      if (!parseResult.ok) {
        res.status(400).json(parseResult.errorBody);
        return;
      }

      const message = AgentMessage.fromDict(req.body as Record<string, unknown>);
      const messageId = message.messageId || randomUUID();

      this.storeMessage(message);

      void this.fireHandlers(message);

      res.json({ status: "received", message_id: messageId });
    });

    // Async callback endpoint for /webhook: the handler stores its result via
    // setResponse(messageId, ...); the caller polls this to fetch it. First
    // hit returns the value and removes it from the map; repeat calls 404.
    //
    // Node is single-threaded, so no explicit lock is needed — the
    // has/get/delete sequence on the Map runs without interruption.
    this.app.get("/webhook/response/:message_id", (req: Request, res: Response) => {
      // req.params in express's typing is `ParamsDictionary` (string | string[]);
      // single-segment route params are always strings in practice — coerce
      // here to satisfy the Map's string key type.
      const raw = req.params["message_id"];
      const messageId = typeof raw === "string" ? raw : "";
      if (this.pendingResponses.has(messageId)) {
        const response = this.pendingResponses.get(messageId)!;
        this.pendingResponses.delete(messageId);
        res.status(200).json({
          status: "success",
          message_id: messageId,
          response,
          timestamp: Date.now() / 1000,
        });
        return;
      }
      res.status(404).json({
        status: "pending_or_unknown",
        message_id: messageId,
        error:
          "No response stored for this message_id (not ready, already fetched, or unknown)",
      });
    });

    this.app.post("/webhook/sync", async (req: Request, res: Response) => {
      if (!isJsonContentType(req)) {
        res.status(400).json({ error: "Content-Type must be application/json" });
        return;
      }

      const parseResult = this.validatePayload(req.body);
      if (!parseResult.ok) {
        res.status(400).json(parseResult.errorBody);
        return;
      }

      const message = AgentMessage.fromDict(req.body as Record<string, unknown>);
      const messageId = message.messageId;

      this.storeMessage(message);

      await this.fireHandlers(message);

      const response = await this.pollForResponse(messageId);

      if (response === null) {
        res.status(408).json({ error: "timeout waiting for response", message_id: messageId });
        return;
      }

      this.pendingResponses.delete(messageId);
      res.json({ status: "success", message_id: messageId, response });
    });
  }

  /**
   * Validate an incoming request body against payloadModel.
   *
   * Returns { ok: true } when no model is configured or validation passes.
   * Returns { ok: false, errorBody } with a flattened Zod-error payload ready
   * to be shipped as the 400 response body when validation fails. The shape
   * mirrors what the Python SDK returns:
   *   { error: "payload validation failed", details: [{ path, message }, ...] }
   */
  private validatePayload(
    body: unknown,
  ): { ok: true } | { ok: false; errorBody: Record<string, unknown> } {
    if (!this.payloadModel) return { ok: true };
    const result = this.payloadModel.safeParse(body);
    if (result.success) return { ok: true };
    return {
      ok: false,
      errorBody: {
        error: "payload validation failed",
        details: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      },
    };
  }

  /**
   * Convert express.json's size / parse errors into clean JSON responses.
   * - entity.too.large / PayloadTooLargeError -> 413 with the configured limit
   * - entity.parse.failed (malformed JSON) -> 400 with the parse error message
   * Registered after routes so it only intercepts errors propagated via next().
   */
  private registerErrorHandler(): void {
    this.app.use(
      (
        err: NodeJS.ErrnoException & { type?: string; status?: number },
        _req: Request,
        res: Response,
        next: express.NextFunction,
      ) => {
        if (res.headersSent) {
          next(err);
          return;
        }
        if (err?.type === "entity.too.large" || err?.status === 413) {
          res.status(413).json({
            error: "payload too large",
            max_file_size_bytes: this.maxFileSizeBytes,
          });
          return;
        }
        if (err?.type === "entity.parse.failed" || err?.status === 400) {
          res.status(400).json({ error: `invalid JSON: ${err.message}` });
          return;
        }
        res.status(500).json({
          error: err?.message ?? "internal server error",
        });
      },
    );
  }

  private storeMessage(message: AgentMessage): void {
    const entry = { message, receivedAt: Date.now() / 1000 };
    this.receivedMessages.push(entry);
    this.messageHistory.push(entry);
    if (this.messageHistory.length > this.messageHistoryLimit) {
      this.messageHistory.splice(0, this.messageHistory.length - this.messageHistoryLimit);
    }
  }

  private async fireHandlers(message: AgentMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(message, null);
      } catch (err) {
        console.error(`WebhookCommunicationManager: handler threw for message ${message.messageId}:`, err);
      }
    }
  }

  // Polls pendingResponses every SYNC_POLL_INTERVAL_MS for up to SYNC_TIMEOUT_MS.
  // Returns the response string, or null on timeout.
  private pollForResponse(messageId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const deadline = Date.now() + SYNC_TIMEOUT_MS;

      const tick = (): void => {
        const response = this.pendingResponses.get(messageId);
        if (response !== undefined) {
          resolve(response);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(tick, SYNC_POLL_INTERVAL_MS);
      };

      tick();
    });
  }
}

function isJsonContentType(req: Request): boolean {
  const ct = req.headers["content-type"] ?? "";
  // application/json or application/json; charset=utf-8
  return ct.includes("application/json");
}
