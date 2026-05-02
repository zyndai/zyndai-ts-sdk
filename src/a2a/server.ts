/**
 * A2A server — Express handlers mounted at the agent's base URL.
 *
 * Routes:
 *   POST /a2a/v1
 *     - Single JSON-RPC request → dispatched on `method`.
 *     - For `message/stream`, returns text/event-stream and writes one
 *       JSON-RPC response per SSE frame until the task reaches a terminal
 *       state.
 *   GET /.well-known/agent-card.json
 *     - Serves the A2A-shaped Agent Card (JSON, signed by the agent's key).
 *   GET /health
 *     - Liveness probe.
 *
 * The dispatcher is purposely simple: this is a single-tenant server, one
 * agent per process. No multiplexing, no connection pooling.
 */

import express from "express";
import type { Application, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MessageSchema,
  MessageSendParamsSchema,
  TaskQueryParamsSchema,
  TaskIdParamsSchema,
  TaskPushNotificationConfigSchema,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  A2A_TASK_NOT_FOUND,
  A2A_TASK_NOT_CANCELABLE,
  ZYND_AUTH_FAILED,
  ZYND_REPLAY_DETECTED,
  ZYND_AUTH_EXPIRED,
  TERMINAL_STATES,
} from "./types.js";
import type {
  Message,
  ATask,
  Artifact,
  JsonRpcResponse,
  StreamEvent,
  PushNotificationConfig,
  TaskState,
} from "./types.js";
import {
  verifyMessage,
  ZyndAuthError,
  ReplayCache,
  signMessage,
  type AuthMode,
} from "./auth.js";
import { TaskStore } from "./task-store.js";
import {
  fromA2AMessage,
  toA2AMessage,
  coerceHandlerOutput,
  type Attachment,
} from "./adapter.js";
import type { Ed25519Keypair } from "../identity.js";
import { AgentMessage } from "../message.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface TaskHandle {
  readonly id: string;
  readonly contextId: string;
  /** Current state. */
  readonly state: TaskState;
  /** Update task state and broadcast a status-update event. */
  update(state: TaskState, opts?: { text?: string }): Promise<void>;
  /** Push a (possibly chunked) artifact. */
  emitArtifact(
    artifact: Omit<Artifact, "artifactId"> & { artifactId?: string },
    opts?: { append?: boolean; lastChunk?: boolean },
  ): Promise<void>;
  /**
   * Ask the caller for more information. Transitions task to
   * `input-required`, sends the question via the active transport, and
   * suspends the handler until the caller responds with a message carrying
   * the same taskId. Returns the new InboundMessage.
   *
   * The returned object exposes `.payload` and `.attachments`, exactly like
   * the initial message handed to the handler.
   */
  ask(
    question: string,
    opts?: { data?: Record<string, unknown> },
  ): Promise<HandlerInput>;
  /** Same as ask() but signals an auth-required state instead. */
  requireAuth(scheme: string, details?: Record<string, unknown>): Promise<HandlerInput>;
  /** Mark the task `completed` with this final result. */
  complete(result: unknown): Promise<HandlerResult>;
  /** Mark the task `failed` with this reason. */
  fail(reason: string): Promise<HandlerResult>;
  /** Mark the task `canceled`. */
  cancel(): Promise<HandlerResult>;
}

/**
 * What the handler receives. `payload` is the validated payload (when a
 * payloadModel is configured) merged from DataParts + content + attachments.
 */
export interface HandlerInput {
  message: AgentMessage;
  payload: Record<string, unknown>;
  attachments: Attachment[];
  fromAgent: boolean;
  /** True when the inbound message was Zynd-signed and verified. */
  signed: boolean;
  /** Verified entity_id of the sender, when signed. */
  senderEntityId: string | null;
  /** Verified FQAN of the sender, when included. */
  senderFqan: string | null;
}

export type HandlerResult = { __zynd_done: true };

export type Handler = (
  input: HandlerInput,
  task: TaskHandle,
) => Promise<HandlerResult | unknown> | HandlerResult | unknown;

export interface A2AServerOptions {
  entityId: string;
  fqan?: string;
  keypair: Ed25519Keypair;
  /** Builds the live AgentCard JSON. Called fresh per request. */
  agentCardBuilder: () => Record<string, unknown>;
  /** Host to bind. Default 0.0.0.0. */
  host?: string;
  /** Port to bind. Default 5000. */
  port?: number;
  /** Mount path for the JSON-RPC endpoint. Default /a2a/v1. */
  a2aPath?: string;
  /** Inbound auth-mode (per agent setting). Default "permissive". */
  authMode?: AuthMode;
  /** Max body size in bytes for inbound A2A requests. Default 25 MiB. */
  maxBodyBytes?: number;
  /** Default for handler payloadModel — validated against parsed inbound. */
  payloadModel?: z.ZodTypeAny;
  /** Default for handler outputModel — validated against handler return. */
  outputModel?: z.ZodTypeAny;
  /** Optional developer-derivation proof for the agent's first message in a
   *  conversation. When supplied, included in outbound x-zynd-auth blocks
   *  the SDK emits (responses + push notifications). */
  developerProof?: import("./types.js").ZyndAuth["developer_proof"];
  /** Idle TTL for tasks parked in input-required. Default 1h. */
  idleTtlMs?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

export class A2AServer {
  private readonly opts: Required<
    Pick<A2AServerOptions, "host" | "port" | "a2aPath" | "authMode" | "maxBodyBytes">
  > &
    A2AServerOptions;
  private readonly app: Application;
  private server: Server | null = null;
  private _isRunning = false;
  private _boundPort = 0;

  private readonly taskStore: TaskStore;
  private readonly replayCache = new ReplayCache();
  private handler: Handler | null = null;

  constructor(opts: A2AServerOptions) {
    this.opts = {
      host: opts.host ?? "0.0.0.0",
      port: opts.port ?? 5000,
      a2aPath: opts.a2aPath ?? "/a2a/v1",
      authMode: opts.authMode ?? "permissive",
      maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ...opts,
    };

    this.taskStore = new TaskStore({ idleTtlMs: opts.idleTtlMs });
    this.app = express();
    this.app.use(express.json({ limit: this.opts.maxBodyBytes }));
    this.registerRoutes();
    this.registerErrorHandler();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  setHandler(fn: Handler): void {
    this.handler = fn;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }
  get port(): number {
    return this._boundPort;
  }
  get a2aUrl(): string {
    const host = this.opts.host === "0.0.0.0" ? "127.0.0.1" : this.opts.host;
    return `http://${host}:${this._boundPort}${this.opts.a2aPath}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(this.app);
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Cannot start A2A server: port ${this.opts.port} on ${this.opts.host} is already in use. ` +
                `Stop the process using it or pick a different port.`,
              { cause: err },
            ),
          );
          return;
        }
        reject(err);
      });
      server.listen(this.opts.port, this.opts.host, () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          reject(new Error("A2A server: unexpected address type"));
          return;
        }
        this.server = server;
        this._boundPort = addr.port;
        this._isRunning = true;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.taskStore.shutdown();
      if (!this.server) {
        this._isRunning = false;
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else {
          this._isRunning = false;
          resolve();
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  private registerRoutes(): void {
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({ status: "ok", entity_id: this.opts.entityId, timestamp: new Date().toISOString() });
    });

    // Serve the A2A-shaped Agent Card. The legacy `/.well-known/agent.json`
    // path is intentionally not served — the new card schema is the only
    // shape going forward.
    this.app.get("/.well-known/agent-card.json", (_req: Request, res: Response) => {
      try {
        res.json(this.opts.agentCardBuilder());
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : "card build failed",
        });
      }
    });

    this.app.post(this.opts.a2aPath, async (req: Request, res: Response) => {
      let parsed: { jsonrpc: "2.0"; id: string | number | null; method: string; params: unknown };
      try {
        parsed = req.body as typeof parsed;
        if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
          this.respondError(res, parsed?.id ?? null, RPC_INVALID_REQUEST, "Not a valid JSON-RPC 2.0 request");
          return;
        }
      } catch {
        this.respondError(res, null, RPC_PARSE_ERROR, "Parse error");
        return;
      }

      const id = parsed.id ?? null;
      try {
        switch (parsed.method) {
          case "message/send":
            return await this.handleMessageSend(req, res, id, parsed.params);
          case "message/stream":
            return await this.handleMessageStream(req, res, id, parsed.params);
          case "tasks/get":
            return this.handleTasksGet(res, id, parsed.params);
          case "tasks/cancel":
            return await this.handleTasksCancel(res, id, parsed.params);
          case "tasks/resubscribe":
            return this.handleTasksResubscribe(req, res, id, parsed.params);
          case "tasks/pushNotificationConfig/set":
            return this.handlePushSet(res, id, parsed.params);
          case "tasks/pushNotificationConfig/get":
            return this.handlePushGet(res, id, parsed.params);
          default:
            this.respondError(res, id, RPC_METHOD_NOT_FOUND, `Method not found: ${parsed.method}`);
        }
      } catch (err) {
        console.error("[a2a-server] dispatch threw:", err);
        this.respondError(
          res,
          id,
          RPC_INTERNAL_ERROR,
          err instanceof Error ? err.message : "Internal error",
        );
      }
    });
  }

  private registerErrorHandler(): void {
    this.app.use((err: NodeJS.ErrnoException & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      if (err?.type === "entity.too.large" || err?.status === 413) {
        res.status(413).json({ error: "payload too large", max: this.opts.maxBodyBytes });
        return;
      }
      if (err?.type === "entity.parse.failed" || err?.status === 400) {
        res.status(400).json({ error: `invalid JSON: ${err.message}` });
        return;
      }
      res.status(500).json({ error: err?.message ?? "internal server error" });
    });
  }

  // -------------------------------------------------------------------------
  // message/send  (synchronous)
  // -------------------------------------------------------------------------

  private async handleMessageSend(
    _req: Request,
    res: Response,
    id: string | number | null,
    params: unknown,
  ): Promise<void> {
    const parseResult = MessageSendParamsSchema.safeParse(params);
    if (!parseResult.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parseResult.error.issues);
      return;
    }
    const { message } = parseResult.data;

    // Verify x-zynd-auth.
    let authCtx;
    try {
      authCtx = verifyMessage(message, {
        mode: this.opts.authMode,
        replayCache: this.replayCache,
      });
    } catch (e) {
      const err = e as ZyndAuthError;
      const code =
        err.reason === "replay_detected"
          ? ZYND_REPLAY_DETECTED
          : err.reason === "expired_or_skewed"
            ? ZYND_AUTH_EXPIRED
            : ZYND_AUTH_FAILED;
      this.respondError(res, id, code, err.message);
      return;
    }

    // Resolve task.
    const taskId = message.taskId ?? this.taskStore.newTaskId();
    const contextId = message.contextId ?? this.taskStore.newContextId();
    const entry = this.taskStore.getOrCreate(taskId, contextId);

    // Pick up an inline pushNotificationConfig if the caller passed one in
    // params.configuration. Saves a separate
    // tasks/pushNotificationConfig/set round trip and matches the A2A
    // MessageSendConfiguration spec.
    this.maybeSetInlinePushConfig(taskId, parseResult.data.configuration);

    // Resume suspended handler if applicable.
    if (entry.task.status.state === "input-required" || entry.task.status.state === "auth-required") {
      const resumed = this.taskStore.resumeIfSuspended(taskId, message);
      if (resumed) {
        // Wait briefly for the handler to settle into a new terminal/interrupted state.
        await this.waitForSettle(taskId);
        const finalTask = this.taskStore.get(taskId);
        if (finalTask) this.respondSuccess(res, id, finalTask);
        else this.respondError(res, id, A2A_TASK_NOT_FOUND, "Task vanished while resuming");
        return;
      }
    }

    // Fresh dispatch.
    this.taskStore.appendMessage(taskId, message);
    this.taskStore.setState(taskId, "working");

    void this.dispatch(taskId, contextId, message, authCtx);

    // Wait for settle (terminal or interrupted).
    await this.waitForSettle(taskId);
    const finalTask = this.taskStore.get(taskId);
    if (finalTask) this.respondSuccess(res, id, finalTask);
    else this.respondError(res, id, A2A_TASK_NOT_FOUND, "Task vanished after dispatch");
  }

  // -------------------------------------------------------------------------
  // message/stream  (SSE)
  // -------------------------------------------------------------------------

  private async handleMessageStream(
    _req: Request,
    res: Response,
    id: string | number | null,
    params: unknown,
  ): Promise<void> {
    const parseResult = MessageSendParamsSchema.safeParse(params);
    if (!parseResult.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parseResult.error.issues);
      return;
    }
    const { message } = parseResult.data;

    let authCtx;
    try {
      authCtx = verifyMessage(message, {
        mode: this.opts.authMode,
        replayCache: this.replayCache,
      });
    } catch (e) {
      const err = e as ZyndAuthError;
      this.respondError(res, id, ZYND_AUTH_FAILED, err.message);
      return;
    }

    const taskId = message.taskId ?? this.taskStore.newTaskId();
    const contextId = message.contextId ?? this.taskStore.newContextId();
    this.taskStore.getOrCreate(taskId, contextId);
    this.taskStore.appendMessage(taskId, message);

    // Inline pushNotificationConfig — same shortcut as message/send.
    this.maybeSetInlinePushConfig(taskId, parseResult.data.configuration);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Subscribe before kicking off dispatch — guarantees we don't miss the
    // initial `working` transition.
    const writeFrame = (payload: JsonRpcResponse): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const unsubscribe = this.taskStore.subscribe(taskId, (event: StreamEvent) => {
      writeFrame({ jsonrpc: "2.0", id, result: event });
    });

    // Tear down on client disconnect.
    res.on("close", () => unsubscribe());

    this.taskStore.setState(taskId, "working");
    void this.dispatch(taskId, contextId, message, authCtx);

    // The status-update with final:true closes the stream.
    const closeWatcher = setInterval(() => {
      const t = this.taskStore.get(taskId);
      if (!t) {
        clearInterval(closeWatcher);
        unsubscribe();
        res.end();
        return;
      }
      if (TERMINAL_STATES.has(t.status.state)) {
        clearInterval(closeWatcher);
        unsubscribe();
        res.end();
      }
    }, 100);
  }

  // -------------------------------------------------------------------------
  // tasks/get
  // -------------------------------------------------------------------------

  private handleTasksGet(res: Response, id: string | number | null, params: unknown): void {
    const parsed = TaskQueryParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parsed.error.issues);
      return;
    }
    const task = this.taskStore.get(parsed.data.id);
    if (!task) {
      this.respondError(res, id, A2A_TASK_NOT_FOUND, `Task ${parsed.data.id} not found`);
      return;
    }
    this.respondSuccess(res, id, task);
  }

  // -------------------------------------------------------------------------
  // tasks/cancel
  // -------------------------------------------------------------------------

  private async handleTasksCancel(res: Response, id: string | number | null, params: unknown): Promise<void> {
    const parsed = TaskIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parsed.error.issues);
      return;
    }
    const task = this.taskStore.get(parsed.data.id);
    if (!task) {
      this.respondError(res, id, A2A_TASK_NOT_FOUND, `Task ${parsed.data.id} not found`);
      return;
    }
    if (TERMINAL_STATES.has(task.status.state)) {
      this.respondError(res, id, A2A_TASK_NOT_CANCELABLE, `Task already in terminal state ${task.status.state}`);
      return;
    }
    this.taskStore.setState(parsed.data.id, "canceled");
    const after = this.taskStore.get(parsed.data.id);
    this.respondSuccess(res, id, after);
  }

  // -------------------------------------------------------------------------
  // tasks/resubscribe
  // -------------------------------------------------------------------------

  private handleTasksResubscribe(
    _req: Request,
    res: Response,
    id: string | number | null,
    params: unknown,
  ): void {
    const parsed = TaskIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parsed.error.issues);
      return;
    }
    if (!this.taskStore.has(parsed.data.id)) {
      this.respondError(res, id, A2A_TASK_NOT_FOUND, `Task ${parsed.data.id} not found`);
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const writeFrame = (payload: JsonRpcResponse): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = this.taskStore.subscribe(parsed.data.id, (event) => {
      writeFrame({ jsonrpc: "2.0", id, result: event });
    });
    res.on("close", () => unsubscribe());

    // Send current task state as the first event so the resubscriber catches up.
    const cur = this.taskStore.get(parsed.data.id);
    if (cur) writeFrame({ jsonrpc: "2.0", id, result: { kind: "task", task: cur } });

    if (cur && TERMINAL_STATES.has(cur.status.state)) {
      unsubscribe();
      res.end();
    }
  }

  // -------------------------------------------------------------------------
  // tasks/pushNotificationConfig
  // -------------------------------------------------------------------------

  private handlePushSet(res: Response, id: string | number | null, params: unknown): void {
    const parsed = TaskPushNotificationConfigSchema.safeParse(params);
    if (!parsed.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parsed.error.issues);
      return;
    }
    if (!this.taskStore.has(parsed.data.taskId)) {
      this.respondError(res, id, A2A_TASK_NOT_FOUND, `Task ${parsed.data.taskId} not found`);
      return;
    }
    this.taskStore.setPushConfig(parsed.data.taskId, parsed.data.pushNotificationConfig);
    this.respondSuccess(res, id, parsed.data);
  }

  private handlePushGet(res: Response, id: string | number | null, params: unknown): void {
    const parsed = TaskIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.respondError(res, id, RPC_INVALID_PARAMS, "Invalid params", parsed.error.issues);
      return;
    }
    const cfg = this.taskStore.getPushConfig(parsed.data.id);
    if (!cfg) {
      this.respondError(res, id, A2A_TASK_NOT_FOUND, `No push config for task ${parsed.data.id}`);
      return;
    }
    this.respondSuccess(res, id, { taskId: parsed.data.id, pushNotificationConfig: cfg });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    taskId: string,
    contextId: string,
    message: Message,
    authCtx: { signed: boolean; entityId: string | null; fqan: string | null },
  ): Promise<void> {
    if (!this.handler) {
      this.taskStore.setState(taskId, "rejected", this.errorMessage("No handler is registered on this agent"));
      return;
    }

    const inbound = fromA2AMessage(message, this.opts.payloadModel);
    const handlerInput: HandlerInput = {
      message: inbound.message,
      payload: inbound.payload,
      attachments: inbound.attachments,
      fromAgent: inbound.fromAgent,
      signed: authCtx.signed,
      senderEntityId: authCtx.entityId,
      senderFqan: authCtx.fqan,
    };

    const handle = this.makeTaskHandle(taskId, contextId);

    try {
      const ret = await this.handler(handlerInput, handle);
      // Sentinel returns from task.complete/fail/cancel mean state was already
      // written by the handle. Other return values mean the handler returned
      // a result implicitly — auto-complete with that as the artifact.
      if (ret && typeof ret === "object" && "__zynd_done" in (ret as Record<string, unknown>)) {
        return;
      }
      // Auto-complete only if not already terminal.
      const cur = this.taskStore.get(taskId);
      if (cur && !TERMINAL_STATES.has(cur.status.state)) {
        await handle.complete(ret);
      }
    } catch (err) {
      const cur = this.taskStore.get(taskId);
      if (cur && !TERMINAL_STATES.has(cur.status.state)) {
        await handle.fail(err instanceof Error ? err.message : String(err));
      }
    }

    // Push delivery on terminal events.
    void this.deliverPushIfConfigured(taskId);
  }

  private makeTaskHandle(taskId: string, contextId: string): TaskHandle {
    const self = this;
    return {
      get id() {
        return taskId;
      },
      get contextId() {
        return contextId;
      },
      get state() {
        return self.taskStore.get(taskId)?.status.state ?? "unknown";
      },

      async update(state: TaskState, opts?: { text?: string }): Promise<void> {
        const msg = opts?.text ? self.agentMessage(opts.text, contextId, taskId) : undefined;
        self.taskStore.setState(taskId, state, msg);
      },

      async emitArtifact(artifact, opts) {
        const full: Artifact = {
          artifactId: artifact.artifactId ?? randomUUID(),
          ...(artifact.name ? { name: artifact.name } : {}),
          ...(artifact.description ? { description: artifact.description } : {}),
          parts: artifact.parts,
          ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
        };
        self.taskStore.appendArtifact(taskId, full, opts);
      },

      async ask(question: string, opts?: { data?: Record<string, unknown> }): Promise<HandlerInput> {
        const ask = self.agentMessage(question, contextId, taskId, opts?.data);
        self.taskStore.setState(taskId, "input-required", ask);
        const reply = await self.taskStore.suspendUntilNextMessage(taskId);
        // The reply was already verified in handleMessageSend before being
        // routed to us via resumeIfSuspended — don't re-verify (would trip
        // the replay cache on the same nonce).
        const inbound = fromA2AMessage(reply, self.opts.payloadModel);
        const cur = self.taskStore.get(taskId);
        const senderEntity =
          (reply.metadata?.["x-zynd-auth"] as { entity_id?: string } | undefined)?.entity_id ?? null;
        const senderFqan =
          (reply.metadata?.["x-zynd-auth"] as { fqan?: string } | undefined)?.fqan ?? null;
        if (cur) self.taskStore.setState(taskId, "working");
        self.taskStore.appendMessage(taskId, reply);
        return {
          message: inbound.message,
          payload: inbound.payload,
          attachments: inbound.attachments,
          fromAgent: inbound.fromAgent,
          signed: !!reply.metadata?.["x-zynd-auth"],
          senderEntityId: senderEntity,
          senderFqan,
        };
      },

      async requireAuth(scheme: string, details?: Record<string, unknown>): Promise<HandlerInput> {
        const ask = self.agentMessage(`Authentication required (${scheme})`, contextId, taskId, {
          authScheme: scheme,
          ...details,
        });
        self.taskStore.setState(taskId, "auth-required", ask);
        const reply = await self.taskStore.suspendUntilNextMessage(taskId);
        // Already verified in handleMessageSend before being routed here.
        const inbound = fromA2AMessage(reply, self.opts.payloadModel);
        self.taskStore.setState(taskId, "working");
        self.taskStore.appendMessage(taskId, reply);
        return {
          message: inbound.message,
          payload: inbound.payload,
          attachments: inbound.attachments,
          fromAgent: inbound.fromAgent,
          signed: !!reply.metadata?.["x-zynd-auth"],
          senderEntityId: null,
          senderFqan: null,
        };
      },

      async complete(result: unknown): Promise<HandlerResult> {
        const out = coerceHandlerOutput(result);
        if (self.opts.outputModel && out.data) {
          const r = self.opts.outputModel.safeParse(out.data);
          if (!r.success) {
            await this.fail(`handler output failed validation: ${r.error.message}`);
            return { __zynd_done: true };
          }
          out.data = r.data as Record<string, unknown>;
        }

        // Emit final result as an artifact + completed status.
        const artifact: Artifact = {
          artifactId: randomUUID(),
          name: "result",
          parts: [],
        };
        if (out.data && Object.keys(out.data).length > 0) {
          artifact.parts.push({ kind: "data", data: out.data });
        }
        if (out.text) artifact.parts.push({ kind: "text", text: out.text });
        if (out.attachments) {
          for (const att of out.attachments) {
            artifact.parts.push({
              kind: "file",
              file: att.data ? { bytes: att.data, name: att.filename, mimeType: att.mimeType } : { uri: att.url ?? "", name: att.filename, mimeType: att.mimeType },
            });
          }
        }
        if (artifact.parts.length === 0) {
          artifact.parts.push({ kind: "text", text: "" });
        }
        self.taskStore.appendArtifact(taskId, artifact);
        self.taskStore.setState(taskId, "completed");
        return { __zynd_done: true };
      },

      async fail(reason: string): Promise<HandlerResult> {
        self.taskStore.setState(taskId, "failed", self.errorMessage(reason, contextId, taskId));
        return { __zynd_done: true };
      },

      async cancel(): Promise<HandlerResult> {
        self.taskStore.setState(taskId, "canceled", self.agentMessage("Task canceled", contextId, taskId));
        return { __zynd_done: true };
      },
    };
  }

  // -------------------------------------------------------------------------
  // Push delivery
  // -------------------------------------------------------------------------

  private async deliverPushIfConfigured(taskId: string): Promise<void> {
    const cfg = this.taskStore.getPushConfig(taskId);
    if (!cfg) return;
    const task = this.taskStore.get(taskId);
    if (!task) return;
    if (!TERMINAL_STATES.has(task.status.state) && !["input-required", "auth-required"].includes(task.status.state)) {
      return;
    }

    // Build a TaskStatusUpdateEvent envelope and POST. We sign with x-zynd-auth
    // when callee is Zynd; for vanilla A2A clients the `token` field acts as
    // a shared secret correlation tag.
    const event = {
      kind: "status-update",
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
      final: TERMINAL_STATES.has(task.status.state),
    };

    // Wrap in a Message-shaped vehicle so we can sign it the same way.
    const wrapper: Message = {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      parts: [{ kind: "data", data: event }],
      taskId: task.id,
      contextId: task.contextId,
    };
    signMessage(wrapper, {
      keypair: this.opts.keypair,
      entityId: this.opts.entityId,
      fqan: this.opts.fqan,
      developerProof: this.opts.developerProof,
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.token) headers["X-A2A-Notification-Token"] = cfg.token;

    try {
      await fetch(cfg.url, {
        method: "POST",
        headers,
        body: JSON.stringify(wrapper),
      });
    } catch (err) {
      console.error(`[a2a-server] push delivery failed for task ${taskId}:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private agentMessage(
    text: string,
    contextId: string,
    taskId: string,
    data?: Record<string, unknown>,
  ): Message {
    const msg = toA2AMessage({
      role: "agent",
      messageId: randomUUID(),
      contextId,
      taskId,
      text,
      ...(data ? { data } : {}),
    });
    signMessage(msg, {
      keypair: this.opts.keypair,
      entityId: this.opts.entityId,
      fqan: this.opts.fqan,
      developerProof: this.opts.developerProof,
    });
    return msg;
  }

  private errorMessage(reason: string, contextId?: string, taskId?: string): Message {
    return this.agentMessage(reason, contextId ?? "", taskId ?? "");
  }

  private respondSuccess(res: Response, id: string | number | null, result: unknown): void {
    const body: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    res.json(body);
  }

  /**
   * Honor `params.configuration.pushNotificationConfig` when present.
   *
   * A2A spec allows the caller to register a callback URL inline with
   * message/send so they don't need a separate
   * tasks/pushNotificationConfig/set round-trip. Accepts both camelCase
   * (the spec) and snake_case (Python clients sometimes serialize this
   * way through field aliases).
   */
  private maybeSetInlinePushConfig(taskId: string, configuration: unknown): void {
    if (!configuration || typeof configuration !== "object") return;
    const cfgRecord = configuration as Record<string, unknown>;
    const raw =
      cfgRecord["pushNotificationConfig"] ??
      cfgRecord["push_notification_config"];
    if (!raw || typeof raw !== "object") return;
    const cfgEntry = raw as Record<string, unknown>;
    const url = cfgEntry["url"];
    if (typeof url !== "string" || url.length === 0) return;
    this.taskStore.setPushConfig(taskId, cfgEntry as Parameters<typeof this.taskStore.setPushConfig>[1]);
  }

  private respondError(
    res: Response,
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const body: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    // Use 200 OK with a JSON-RPC error envelope per spec; the JSON body
    // carries the actual error info.
    res.json(body);
  }

  private waitForSettle(taskId: string, maxMs = 5 * 60 * 1000): Promise<void> {
    // Returns when the task reaches a terminal or interrupted state.
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const t = this.taskStore.get(taskId);
        if (!t) {
          clearInterval(timer);
          resolve();
          return;
        }
        const s = t.status.state;
        if (
          TERMINAL_STATES.has(s) ||
          s === "input-required" ||
          s === "auth-required"
        ) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - start > maxMs) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }
}
