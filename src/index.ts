export {
  Ed25519Keypair,
  generateKeypair,
  keypairFromPrivateBytes,
  loadKeypair,
  loadKeypairWithMetadata,
  saveKeypair,
  generateEntityId,
  generateDeveloperId,
  sign,
  verify,
  deriveAgentKeypair,
  createDerivationProof,
  verifyDerivationProof,
} from "./identity.js";

export { AgentMessage } from "./message.js";
export type { AgentMessageInit } from "./message.js";

export {
  AgentFramework,
  ZyndBaseConfigSchema,
  AgentConfigSchema,
  ServiceConfigSchema,
} from "./types.js";
export type {
  ZyndBaseConfig,
  AgentConfig,
  ServiceConfig,
  AgentSearchResponse,
  SearchRequest,
  SearchResult,
  AgentConfigFile,
  DerivationProof,
} from "./types.js";

export {
  resolveKeypair,
  buildRuntimeCard,
  loadDerivationMetadata,
  resolveProviderFromDeveloper,
} from "./entity-card-loader.js";

export * as DNSRegistryClient from "./registry.js";

export { SearchAndDiscoveryManager } from "./search.js";

export { X402PaymentProcessor } from "./payment.js";

export {
  ConfigManager,
  buildEntityUrl,
  resolveRegistryUrl,
  loadHomeRegistryUrl,
} from "./config-manager.js";

export { ZyndBase } from "./base.js";
export type {
  ValidationOptions,
  Handler,
  HandlerInput,
  TaskHandle,
} from "./base.js";

export { ZyndAIAgent } from "./agent.js";
export { ZyndService } from "./service.js";

export {
  zodToAdvertisedJsonSchema,
  zodSchemaAdvertisement,
} from "./payload-schema.js";

export { encryptMessage, decryptMessage } from "./crypto.js";
export type { EncryptedMessage } from "./crypto.js";

// A2A communication layer — full surface re-exported here so users can
// `import { A2AClient, signMessage, ... } from "zyndai"` without reaching
// into the subdirectory.
export {
  A2AServer,
  A2AClient,
  A2AError,
  resolveA2AEndpoint,
  TaskStore,
  signMessage,
  verifyMessage,
  ZyndAuthError,
  ReplayCache,
  buildAgentCard,
  signAgentCard,
  fromA2AMessage,
  toA2AMessage,
  coerceHandlerOutput,
  taskReplyText,
  partsToReplyText,
  canonicalJson,
  canonicalBytes,
  TERMINAL_STATES,
  INTERRUPTED_STATES,
  ZYND_AUTH_KEY,
  ZYND_AUTH_VERSION,
  ZYND_AUTH_DOMAIN_TAG,
  MessageSchema,
  PartSchema,
  TaskSchema,
  ArtifactSchema,
  TaskStateSchema,
  TaskStatusSchema,
  PushNotificationConfigSchema,
  ZyndAuthSchema,
  DEFAULT_MAX_BODY_BYTES,
} from "./a2a/index.js";

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
  AuthMode,
  SignOptions,
  VerifyOptions,
  VerifyContext,
  Attachment,
  InboundMessage,
  A2AServerOptions,
  ClientOptions,
  CallOptions,
  BuildCardOptions,
  AgentCardSkill,
  AgentCardProvider,
  AgentCardCapabilities,
  AgentCardSecurityScheme,
  SignedAgentCard,
} from "./a2a/index.js";

export const VERSION = "0.3.0";
