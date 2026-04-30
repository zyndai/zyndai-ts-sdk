/**
 * A2A wire types, v0.3 shapes.
 *
 * Source of truth: https://a2a-protocol.org/v0.3.0/specification/
 *
 * We declare both Zod schemas (for inbound validation) and TypeScript
 * interfaces (for outbound construction). The Zod schemas are intentionally
 * lenient on optional fields — A2A says receivers MUST ignore unknown
 * fields, and we follow that. Required fields are enforced; everything else
 * is `.optional().nullable()` where the spec allows it.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Parts (TextPart | FilePart | DataPart)
// -----------------------------------------------------------------------------

export const FileWithBytesSchema = z.object({
  bytes: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
});

export const FileWithUriSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
});

export const FileSchema = z.union([FileWithBytesSchema, FileWithUriSchema]);

export const TextPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export const FilePartSchema = z.object({
  kind: z.literal("file"),
  file: FileSchema,
  metadata: z.record(z.unknown()).optional(),
});

export const DataPartSchema = z.object({
  kind: z.literal("data"),
  data: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
});

export const PartSchema = z.discriminatedUnion("kind", [
  TextPartSchema,
  FilePartSchema,
  DataPartSchema,
]);

export type FileWithBytes = z.infer<typeof FileWithBytesSchema>;
export type FileWithUri = z.infer<typeof FileWithUriSchema>;
export type AFile = FileWithBytes | FileWithUri;
export type TextPart = z.infer<typeof TextPartSchema>;
export type FilePart = z.infer<typeof FilePartSchema>;
export type DataPart = z.infer<typeof DataPartSchema>;
export type Part = TextPart | FilePart | DataPart;

// -----------------------------------------------------------------------------
// Message
// -----------------------------------------------------------------------------

export const MessageRoleSchema = z.enum(["user", "agent"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  kind: z.literal("message").optional(),
  messageId: z.string(),
  role: MessageRoleSchema,
  parts: z.array(PartSchema),
  taskId: z.string().optional(),
  contextId: z.string().optional(),
  referenceTaskIds: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// -----------------------------------------------------------------------------
// Task lifecycle
// -----------------------------------------------------------------------------

export const TaskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "unknown",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set([
  "input-required",
  "auth-required",
]);

export const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ArtifactSchema = z.object({
  artifactId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(PartSchema),
  metadata: z.record(z.unknown()).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TaskSchema = z.object({
  kind: z.literal("task").optional(),
  id: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  artifacts: z.array(ArtifactSchema).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ATask = z.infer<typeof TaskSchema>;

// -----------------------------------------------------------------------------
// Streaming events
// -----------------------------------------------------------------------------

export const TaskStatusUpdateEventSchema = z.object({
  kind: z.literal("status-update"),
  taskId: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  final: z.boolean(),
  metadata: z.record(z.unknown()).optional(),
});
export type TaskStatusUpdateEvent = z.infer<typeof TaskStatusUpdateEventSchema>;

export const TaskArtifactUpdateEventSchema = z.object({
  kind: z.literal("artifact-update"),
  taskId: z.string(),
  contextId: z.string(),
  artifact: ArtifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type TaskArtifactUpdateEvent = z.infer<typeof TaskArtifactUpdateEventSchema>;

export type StreamEvent =
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent
  | { kind: "task"; task: ATask }
  | { kind: "message"; message: Message };

// -----------------------------------------------------------------------------
// JSON-RPC envelope
// -----------------------------------------------------------------------------

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// JSON-RPC 2.0 standard error codes + A2A-defined codes.
// Spec: https://a2a-protocol.org/v0.3.0/specification/#errors
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;
export const A2A_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
export const A2A_UNSUPPORTED_OPERATION = -32004;
export const A2A_CONTENT_TYPE_NOT_SUPPORTED = -32005;
export const A2A_INVALID_AGENT_RESPONSE = -32006;
export const A2A_AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED = -32007;
// Zynd-specific:
export const ZYND_AUTH_FAILED = -32100;
export const ZYND_REPLAY_DETECTED = -32101;
export const ZYND_AUTH_EXPIRED = -32102;

// -----------------------------------------------------------------------------
// Method param shapes
// -----------------------------------------------------------------------------

export const MessageSendParamsSchema = z.object({
  message: MessageSchema,
  configuration: z
    .object({
      blocking: z.boolean().optional(),
      acceptedOutputModes: z.array(z.string()).optional(),
      pushNotificationConfig: z.unknown().optional(),
      historyLength: z.number().int().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type MessageSendParams = z.infer<typeof MessageSendParamsSchema>;

export const TaskIdParamsSchema = z.object({
  id: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type TaskIdParams = z.infer<typeof TaskIdParamsSchema>;

export const TaskQueryParamsSchema = z.object({
  id: z.string(),
  historyLength: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type TaskQueryParams = z.infer<typeof TaskQueryParamsSchema>;

// -----------------------------------------------------------------------------
// Push notification config
// -----------------------------------------------------------------------------

export const PushNotificationAuthSchema = z.object({
  schemes: z.array(z.string()),
  credentials: z.string().nullable().optional(),
});

export const PushNotificationConfigSchema = z.object({
  url: z.string(),
  token: z.string().optional(),
  authentication: PushNotificationAuthSchema.optional(),
});
export type PushNotificationConfig = z.infer<typeof PushNotificationConfigSchema>;

export const TaskPushNotificationConfigSchema = z.object({
  taskId: z.string(),
  pushNotificationConfig: PushNotificationConfigSchema,
});
export type TaskPushNotificationConfig = z.infer<typeof TaskPushNotificationConfigSchema>;

// -----------------------------------------------------------------------------
// x-zynd-auth
// -----------------------------------------------------------------------------

export const DerivationProofSchema = z.object({
  developer_public_key: z.string(),
  entity_index: z.number().int(),
  developer_signature: z.string(),
});

/**
 * Per-message authorization block embedded in `Message.metadata["x-zynd-auth"]`.
 *
 * The signature covers JCS(message) with this whole block's `signature` field
 * blanked (replaced with empty string). See `auth.ts` for the exact rules.
 */
export const ZyndAuthSchema = z.object({
  v: z.literal(1),
  entity_id: z.string(),
  fqan: z.string().optional(),
  public_key: z.string(),
  nonce: z.string(),
  issued_at: z.string(),
  expires_at: z.string(),
  signature: z.string(),
  developer_proof: DerivationProofSchema.optional(),
});
export type ZyndAuth = z.infer<typeof ZyndAuthSchema>;

export const ZYND_AUTH_KEY = "x-zynd-auth";
export const ZYND_AUTH_VERSION = 1 as const;
export const ZYND_AUTH_DOMAIN_TAG = "ZYND-A2A-MSG-v1\n";
