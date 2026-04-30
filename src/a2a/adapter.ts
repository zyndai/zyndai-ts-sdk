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
  // canonical text field (matches AgentMessage), expose attachments alongside.
  const payloadDict: Record<string, unknown> = {
    ...dataMerge,
    content: content || (dataMerge["content"] as string | undefined) || "",
    attachments,
    sender_id:
      (message.metadata?.["x-zynd-auth"] as { entity_id?: string } | undefined)
        ?.entity_id ?? "unknown",
    message_id: message.messageId,
    conversation_id: message.contextId,
    in_reply_to: message.taskId ?? null,
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
