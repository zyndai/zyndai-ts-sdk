/**
 * Adapter between A2A wire types and the SDK's high-level AgentMessage.
 *
 * Inbound:  A2A Message → AgentMessage (with content, attachments, payload)
 * Outbound: AgentMessage → A2A Message (with TextParts, FileParts, DataParts)
 *
 * The handler-facing AgentMessage stays roughly what it was — only the wire
 * shape changes. Existing handler code that reads `message.content` still
 * works.
 */

import { z } from "zod";
import { AgentMessage } from "../message.js";
import type {
  Message,
  Part,
  TextPart,
  FilePart,
  DataPart,
  AFile,
} from "./types.js";

// -----------------------------------------------------------------------------
// Attachment — handler-facing representation
// -----------------------------------------------------------------------------

export interface Attachment {
  filename?: string;
  mimeType?: string;
  /** Base64-encoded bytes when the part was inline. */
  data?: string;
  /** URL when the part was a remote reference. */
  url?: string;
}

function fileToAttachment(file: AFile): Attachment {
  const att: Attachment = {};
  if (file.name) att.filename = file.name;
  if (file.mimeType) att.mimeType = file.mimeType;
  if ("bytes" in file) att.data = file.bytes;
  if ("uri" in file) att.url = file.uri;
  return att;
}

function attachmentToFile(att: Attachment): AFile {
  const base = {
    ...(att.filename !== undefined ? { name: att.filename } : {}),
    ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
  };
  if (att.data !== undefined) return { ...base, bytes: att.data };
  if (att.url !== undefined) return { ...base, uri: att.url };
  throw new Error("attachmentToFile: Attachment has neither `data` nor `url`");
}

// -----------------------------------------------------------------------------
// A2A Message → AgentMessage
// -----------------------------------------------------------------------------

export interface InboundMessage {
  /** The high-level handler-facing message (legacy API). */
  message: AgentMessage;
  /** Same data, more structured: parsed payload + attachments. */
  payload: Record<string, unknown>;
  attachments: Attachment[];
  /** True when sender role was "agent" (i.e. another agent calling us
   *  inside a multi-turn task). */
  fromAgent: boolean;
}

/**
 * Parse an inbound A2A Message into a payload dict ready for handler dispatch.
 *
 * Conversion rules:
 *   - All TextParts are concatenated (newline-joined) into the legacy
 *     `content` field.
 *   - All DataParts are merged into the payload object. Later parts win
 *     on key collision.
 *   - All FileParts become Attachments. The handler reads them via
 *     `attachments` or via the validated payload model.
 *
 * If `payloadModel` is supplied, the merged object is validated against it.
 * Validation errors propagate to the caller, who should map them to a
 * JSON-RPC error response.
 */
export function fromA2AMessage(
  message: Message,
  payloadModel?: z.ZodTypeAny,
): InboundMessage {
  const texts: string[] = [];
  const dataMerge: Record<string, unknown> = {};
  const attachments: Attachment[] = [];

  for (const part of message.parts) {
    if (part.kind === "text") {
      texts.push(part.text);
    } else if (part.kind === "data") {
      const d = part.data;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        Object.assign(dataMerge, d as Record<string, unknown>);
      }
    } else if (part.kind === "file") {
      attachments.push(fileToAttachment(part.file));
    }
  }

  const content = texts.join("\n").trim();

  // Compose the payload object the handler will see. Keep `content` as the
  // canonical text field (matches AgentMessage) and expose `prompt` as an
  // alias so legacy RequestPayload schemas declared as `{ prompt: z.string() }`
  // still validate. Mirrors the Python SDK's `_prompt_aliases_content`
  // model_validator in payload.py.
  const textValue =
    content ||
    (dataMerge["content"] as string | undefined) ||
    (dataMerge["prompt"] as string | undefined) ||
    "";

  // Compose the payload object the handler will see. We only inject
  // `content`/`prompt` when there's actual text — otherwise a service
  // that declares a strict input_schema (e.g. `{ url: string }`) would
  // see noise like `{content: "", prompt: "", in_reply_to: null}` and
  // reject the request. Same logic for `attachments` (skip when empty)
  // and `in_reply_to` (skip when null).
  const senderId =
    (message.metadata?.["x-zynd-auth"] as { entity_id?: string } | undefined)
      ?.entity_id ?? "unknown";

  const payloadDict: Record<string, unknown> = {
    ...dataMerge,
    ...(textValue ? { content: textValue, prompt: textValue } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    sender_id: senderId,
    message_id: message.messageId,
    ...(message.contextId !== undefined
      ? { conversation_id: message.contextId }
      : {}),
    ...(message.taskId !== undefined ? { in_reply_to: message.taskId } : {}),
  };

  // Validate when a payload model is supplied. We allow the model to be a
  // ZodObject or any other Zod schema; .parse throws on mismatch.
  let validated: Record<string, unknown> = payloadDict;
  if (payloadModel) {
    validated = payloadModel.parse(payloadDict) as Record<string, unknown>;
  }

  const agentMsg = new AgentMessage({
    content,
    senderId:
      (message.metadata?.["x-zynd-auth"] as { entity_id?: string } | undefined)
        ?.entity_id ?? "unknown",
    senderPublicKey:
      (message.metadata?.["x-zynd-auth"] as { public_key?: string } | undefined)
        ?.public_key,
    messageId: message.messageId,
    conversationId: message.contextId ?? message.messageId,
    metadata: message.metadata ?? {},
  });

  return {
    message: agentMsg,
    payload: validated,
    attachments,
    fromAgent: message.role === "agent",
  };
}

// -----------------------------------------------------------------------------
// AgentMessage / handler output → A2A Message + Parts
// -----------------------------------------------------------------------------

/**
 * Build an A2A Message from raw text + optional structured data + attachments.
 * The Parts are emitted in the order: data first, then text, then files —
 * which keeps the LLM context-window-relevant content (data, text) up front.
 */
export function toA2AMessage(opts: {
  role: "user" | "agent";
  messageId: string;
  contextId?: string;
  taskId?: string;
  text?: string;
  data?: Record<string, unknown>;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}): Message {
  const parts: Part[] = [];

  if (opts.data && Object.keys(opts.data).length > 0) {
    const dataPart: DataPart = { kind: "data", data: opts.data };
    parts.push(dataPart);
  }

  if (opts.text && opts.text.length > 0) {
    const textPart: TextPart = { kind: "text", text: opts.text };
    parts.push(textPart);
  }

  if (opts.attachments) {
    for (const att of opts.attachments) {
      const filePart: FilePart = { kind: "file", file: attachmentToFile(att) };
      parts.push(filePart);
    }
  }

  const msg: Message = {
    kind: "message",
    messageId: opts.messageId,
    role: opts.role,
    parts,
  };
  if (opts.contextId) msg.contextId = opts.contextId;
  if (opts.taskId) msg.taskId = opts.taskId;
  if (opts.metadata) msg.metadata = opts.metadata;

  return msg;
}

/**
 * Extract the agent's reply text from a completed Task.
 *
 * Reads in priority order:
 *   1. task.artifacts[].parts        — where completed-task replies live;
 *                                       handler returns end up here.
 *   2. task.status.message.parts     — when the agent attached a message
 *                                       to a non-terminal status update.
 *   3. (last fallback) task.history  — for input-required loopbacks where
 *                                       the agent's question is the last
 *                                       message in history.
 *
 * **Do NOT read task.history[last] directly** to get the response: history
 * contains the conversation log including your own outbound message, so
 * naive `history[history.length - 1]` returns your input back at you.
 * That misread caused infinite tool loops in early LangChain agents.
 *
 * `TextPart` joined with newlines; `DataPart` contributes its `response`
 * or `text` field if present, else the JSON-stringified data.
 */
export function taskReplyText(task: {
  artifacts?: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>;
  status?: { state?: string; message?: { parts?: ReadonlyArray<unknown> } };
  history?: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>;
}): string {
  const fromArtifacts = (task.artifacts ?? [])
    .map((a) => partsToReplyText(a.parts ?? []))
    .filter(Boolean)
    .join("\n");
  if (fromArtifacts) return fromArtifacts;

  const fromStatus = partsToReplyText(task.status?.message?.parts ?? []);
  if (fromStatus) return fromStatus;

  // Last resort: scan history for the most recent agent-role message.
  // We don't have the role here (the structural type above is loose), so
  // we just take the last message's parts. Callers in input-required
  // flows should rely on the SDK's built-in resume path, not this helper.
  const last = task.history?.[task.history.length - 1];
  if (last) return partsToReplyText(last.parts ?? []);

  return `(task ${task.status?.state ?? "unknown"})`;
}

/**
 * Walk a Parts array and join into a single reply string. Internal helper
 * for taskReplyText — exported for advanced callers who already have a
 * Parts array (e.g. from a status update event).
 */
export function partsToReplyText(parts: ReadonlyArray<unknown>): string {
  const chunks: string[] = [];
  for (const raw of parts) {
    const part = raw as { kind?: string; text?: string; data?: unknown };
    if (part.kind === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    } else if (
      part.kind === "data" &&
      part.data &&
      typeof part.data === "object" &&
      !Array.isArray(part.data)
    ) {
      const d = part.data as Record<string, unknown>;
      if (typeof d["response"] === "string") chunks.push(d["response"] as string);
      else if (typeof d["text"] === "string") chunks.push(d["text"] as string);
      else chunks.push(JSON.stringify(d));
    }
  }
  return chunks.join("\n").trim();
}

/**
 * Coerce a handler return value into the (text, data, attachments) tuple
 * the outbound builder expects.
 *
 * Rules:
 *   - string         → text only
 *   - object w/ `text`/`content`/`data`/`attachments` → use those fields
 *   - other object   → wrap in a single DataPart
 *   - undefined/null → empty text part (kept so receiver always sees a Message)
 */
export function coerceHandlerOutput(value: unknown): {
  text?: string;
  data?: Record<string, unknown>;
  attachments?: Attachment[];
} {
  if (value === null || value === undefined) {
    return { text: "" };
  }
  if (typeof value === "string") {
    return { text: value };
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    const out: { text?: string; data?: Record<string, unknown>; attachments?: Attachment[] } = {};
    if (typeof v["text"] === "string") out.text = v["text"];
    else if (typeof v["content"] === "string") out.text = v["content"];

    if (Array.isArray(v["attachments"])) {
      out.attachments = v["attachments"] as Attachment[];
    }

    if (typeof v["data"] === "object" && v["data"] !== null) {
      out.data = v["data"] as Record<string, unknown>;
    } else if (out.text === undefined && out.attachments === undefined) {
      // Whole object is the data payload.
      out.data = v;
    }
    return out;
  }
  // Numbers/booleans — stringify into text.
  return { text: String(value) };
}
