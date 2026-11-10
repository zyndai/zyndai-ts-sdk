/**
 * Public exports for the A2A communication layer.
 */

export {
  // Wire types
  MessageSchema,
  PartSchema,
  TaskSchema,
  ArtifactSchema,
  TaskStateSchema,
  TaskStatusSchema,
  TaskStatusUpdateEventSchema,
  TaskArtifactUpdateEventSchema,
  PushNotificationConfigSchema,
  ZyndAuthSchema,
  // Constants
  TERMINAL_STATES,
  INTERRUPTED_STATES,
  ZYND_AUTH_KEY,
  ZYND_AUTH_VERSION,
  ZYND_AUTH_DOMAIN_TAG,
} from "./types.js";

export type {
  Message,
  MessageRole,
  Part,
  TextPart,
  FilePart,
  DataPart,
  AFile,
  FileWithBytes,
  FileWithUri,
  ATask,
  Artifact,
  TaskStatus,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  StreamEvent,
  PushNotificationConfig,
  TaskPushNotificationConfig,
  ZyndAuth,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonRpcError,
  MessageSendParams,
  TaskIdParams,
  TaskQueryParams,
} from "./types.js";

export { canonicalJson, canonicalBytes } from "./canonical.js";

export {
  signMessage,
  verifyMessage,
  ZyndAuthError,
  ReplayCache,
} from "./auth.js";
export type { AuthMode, SignOptions, VerifyOptions, VerifyContext } from "./auth.js";

export { TaskStore } from "./task-store.js";

export {
  fromA2AMessage,
  toA2AMessage,
  coerceHandlerOutput,
  taskReplyText,
  partsToReplyText,
} from "./adapter.js";
export type { Attachment, InboundMessage } from "./adapter.js";

export { A2AServer, DEFAULT_MAX_BODY_BYTES } from "./server.js";
export type {
  A2AServerOptions,
  Handler,
  HandlerInput,
  HandlerResult,
  TaskHandle,
} from "./server.js";

export {
  A2AClient,
  A2AError,
  resolveA2AEndpoint,
  resolveTransport,
  resolveTransportFromCard,
} from "./client.js";
export type {
  ClientOptions,
  CallOptions,
  A2ATransport,
  ResolvedTransport,
} from "./client.js";

export {
  X402PaymentGate,
  PaymentRequiredError,
  PaymentUnavailableError,
  parsePriceUsd,
  DEFAULT_X402_NETWORK,
  DEFAULT_X402_FACILITATOR_URL,
  DEFAULT_PAYMENT_TIMEOUT_SECONDS,
} from "./payment-gate.js";
export type { PaymentGateOptions, VerifiedPayment, SettledPayment } from "./payment-gate.js";

export { A2APayer, PaymentRefusedError, DEFAULT_MAX_PAYMENT_USD } from "./payment-client.js";
export type { ClientPaymentOptions } from "./payment-client.js";

export { ZYND_PAYMENT_REQUIRED, ZYND_PAYMENT_UNAVAILABLE } from "./types.js";

export { buildAgentCard, signAgentCard } from "./card.js";
export type {
  BuildCardOptions,
  AgentCardSkill,
  AgentCardProvider,
  AgentCardCapabilities,
  AgentCardSecurityScheme,
  SignedAgentCard,
} from "./card.js";
