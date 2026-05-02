/**
 * In-memory task store with suspended-handler resume.
 *
 * Each Task is keyed by its A2A id. The store carries:
 *   - the current Task object (state, history, artifacts)
 *   - a list of attached SSE-stream subscribers (for message/stream)
 *   - the registered push-notification config (for tasks/pushNotificationConfig/set)
 *   - a `resumeResolver` Promise resolver, set when a handler is suspended
 *     waiting on input-required loopback
 *
 * When a follow-up `message/send` arrives with the same taskId and the
 * stored state is `input-required`, we hand the new Message to the
 * resumeResolver so the suspended handler picks up where it left off.
 *
 * Idle GC: tasks in `input-required` / `auth-required` past TTL transition
 * to `failed` with a reason and any subscribers are notified.
 */

import { randomUUID } from "node:crypto";
import type {
  ATask,
  Artifact,
  Message,
  PushNotificationConfig,
  StreamEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";

export type StreamSubscriber = (event: StreamEvent) => void | Promise<void>;

interface TaskEntry {
  task: ATask;
  /** Subscribers attached via message/stream or tasks/resubscribe. */
  subscribers: Set<StreamSubscriber>;
  /** When the handler is awaiting follow-up input, this resolves with the
   *  Message that arrives with the same taskId. */
  resumeResolver?: (msg: Message) => void;
  /** Push-notification config registered for this task. */
  pushConfig?: PushNotificationConfig;
  /** Last activity timestamp — used for idle GC. */
  lastActivity: number;
  /** Terminal state reached — entries are kept briefly for `tasks/get`. */
  terminalAt?: number;
}

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000; // 1h
const TERMINAL_RETENTION_MS = 5 * 60 * 1000; // 5min after terminal
const SWEEP_INTERVAL_MS = 60 * 1000;          // 1min sweep

export class TaskStore {
  private readonly tasks = new Map<string, TaskEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTtlMs: number;

  constructor(opts: { idleTtlMs?: number } = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Don't keep the process alive on this timer.
    this.sweepTimer.unref?.();
  }

  /** Stop the GC sweeper. Call from `agent.stop()`. */
  shutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Generate a fresh task or context id. */
  newTaskId(): string {
    return `task-${randomUUID()}`;
  }
  newContextId(): string {
    return `ctx-${randomUUID()}`;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  get(id: string): ATask | null {
    const e = this.tasks.get(id);
    return e ? structuredClone(e.task) : null;
  }

  /**
   * Look up an existing task or create a new one. Returns the stored entry
   * directly (mutable on purpose — server.ts holds it for the duration of
   * a handler invocation).
   */
  getOrCreate(id: string, contextId: string): TaskEntry {
    let entry = this.tasks.get(id);
    if (entry) {
      entry.lastActivity = Date.now();
      return entry;
    }
    const task: ATask = {
      kind: "task",
      id,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
    };
    entry = {
      task,
      subscribers: new Set(),
      lastActivity: Date.now(),
    };
    this.tasks.set(id, entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  setState(id: string, state: TaskState, message?: Message): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    entry.task.status = {
      state,
      ...(message ? { message } : {}),
      timestamp: new Date().toISOString(),
    };
    entry.lastActivity = Date.now();
    if (TERMINAL_STATES.has(state)) {
      entry.terminalAt = Date.now();
    }

    const event: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId: entry.task.id,
      contextId: entry.task.contextId,
      status: entry.task.status,
      final: TERMINAL_STATES.has(state),
    };
    this.broadcast(entry, event);
  }

  appendMessage(id: string, message: Message): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    if (!entry.task.history) entry.task.history = [];
    entry.task.history.push(message);
    entry.lastActivity = Date.now();
  }

  appendArtifact(
    id: string,
    artifact: Artifact,
    opts: { append?: boolean; lastChunk?: boolean } = {},
  ): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    if (!entry.task.artifacts) entry.task.artifacts = [];

    if (opts.append) {
      const existing = entry.task.artifacts.find(
        (a) => a.artifactId === artifact.artifactId,
      );
      if (existing) {
        existing.parts.push(...artifact.parts);
      } else {
        entry.task.artifacts.push(artifact);
      }
    } else {
      const existingIdx = entry.task.artifacts.findIndex(
        (a) => a.artifactId === artifact.artifactId,
      );
      if (existingIdx >= 0) entry.task.artifacts[existingIdx] = artifact;
      else entry.task.artifacts.push(artifact);
    }
    entry.lastActivity = Date.now();

    this.broadcast(entry, {
      kind: "artifact-update",
      taskId: entry.task.id,
      contextId: entry.task.contextId,
      artifact,
      ...(opts.append ? { append: true } : {}),
      ...(opts.lastChunk ? { lastChunk: true } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Subscribers
  // -------------------------------------------------------------------------

  subscribe(id: string, fn: StreamSubscriber): () => void {
    const entry = this.tasks.get(id);
    if (!entry) return () => undefined;
    entry.subscribers.add(fn);
    return () => entry.subscribers.delete(fn);
  }

  setPushConfig(id: string, cfg: PushNotificationConfig): void {
    const entry = this.tasks.get(id);
    if (entry) entry.pushConfig = cfg;
  }

  getPushConfig(id: string): PushNotificationConfig | undefined {
    return this.tasks.get(id)?.pushConfig;
  }

  private broadcast(entry: TaskEntry, event: StreamEvent): void {
    for (const fn of entry.subscribers) {
      try {
        const r = fn(event);
        if (r instanceof Promise) {
          r.catch((err) =>
            console.error("[task-store] subscriber threw:", err),
          );
        }
      } catch (err) {
        console.error("[task-store] subscriber threw:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Suspend / resume for input-required loopback
  // -------------------------------------------------------------------------

  /**
   * Suspend the current handler waiting for the next message on this task.
   * Returns a Promise that resolves when the next compatible message/send
   * arrives. If the task is canceled or expires before that, the Promise
   * rejects.
   */
  suspendUntilNextMessage(id: string): Promise<Message> {
    const entry = this.tasks.get(id);
    if (!entry) {
      return Promise.reject(new Error(`task ${id} not found`));
    }
    if (entry.resumeResolver) {
      return Promise.reject(
        new Error(`task ${id} already has a pending suspended handler`),
      );
    }
    return new Promise<Message>((resolve, reject) => {
      entry.resumeResolver = resolve;
      // Reject if the task transitions to terminal while suspended.
      const cleanup = setInterval(() => {
        if (!this.tasks.has(id)) {
          clearInterval(cleanup);
          reject(new Error(`task ${id} disappeared while suspended`));
          return;
        }
        const e = this.tasks.get(id)!;
        if (TERMINAL_STATES.has(e.task.status.state) && e.resumeResolver) {
          clearInterval(cleanup);
          e.resumeResolver = undefined;
          reject(new Error(`task ${id} reached terminal state ${e.task.status.state}`));
        }
      }, 500);
      // Resolve cleans up the timer too.
      const wrappedResolve = entry.resumeResolver;
      entry.resumeResolver = (msg: Message) => {
        clearInterval(cleanup);
        wrappedResolve(msg);
      };
    });
  }

  /**
   * If a handler is suspended on this task, hand it the new message and
   * return true. Otherwise return false (caller should treat the message
   * as a fresh dispatch).
   */
  resumeIfSuspended(id: string, msg: Message): boolean {
    const entry = this.tasks.get(id);
    if (!entry || !entry.resumeResolver) return false;
    const r = entry.resumeResolver;
    entry.resumeResolver = undefined;
    r(msg);
    return true;
  }

  // -------------------------------------------------------------------------
  // GC
  // -------------------------------------------------------------------------

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.tasks) {
      if (entry.terminalAt && now - entry.terminalAt > TERMINAL_RETENTION_MS) {
        this.tasks.delete(id);
        continue;
      }
      if (
        !TERMINAL_STATES.has(entry.task.status.state) &&
        now - entry.lastActivity > this.idleTtlMs
      ) {
        // Idle timeout — fail the task and notify subscribers.
        this.setState(id, "failed", {
          kind: "message",
          messageId: randomUUID(),
          role: "agent",
          parts: [
            {
              kind: "text",
              text: `Task timed out after ${Math.round(this.idleTtlMs / 1000)}s of inactivity`,
            },
          ],
        });
        if (entry.resumeResolver) {
          const r = entry.resumeResolver;
          entry.resumeResolver = undefined;
          // Signal abandonment by rejecting via a dummy message that the
          // handler-side wrapper will recognise. Simpler: rely on the
          // setState above triggering the cleanup interval inside
          // suspendUntilNextMessage.
          r({
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: "__zynd_internal_abort__" }],
          });
        }
      }
    }
  }
}
