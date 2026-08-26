export type {
  IMemoryConnector,
  ConnectorConfig,
  ConnectorHealth,
  DistillResult,
  FactDecl,
  CardUpdate,
  SyncResult,
  BridgeConfig,
  CtxConfig,
  MatchResult,
} from "./types.js";

export { MemoryClient } from "./memory-client.js";
export type { MemoryClientConfig } from "./memory-client.js";

export { LinkedInConnector } from "./connectors/linkedin.js";
export { Mem0Connector } from "./connectors/mem0.js";
export { ZepConnector } from "./connectors/zep.js";
export { ZyndNativeConnector } from "./connectors/zynd-native.js";

export { sync, getMatches } from "./sync.js";
export type { SyncOpts } from "./sync.js";

export {
  loadBridgeConfig,
  saveBridgeConfig,
  bridgeConfigPath,
  getMemoryUrl,
  getRegistryUrl,
  getJwtSecret,
  // backward-compat aliases
  loadCtxConfig,
  saveCtxConfig,
  ctxConfigPath,
} from "./config.js";

export { sanitizeString, sanitizeObject, assertEgressClean } from "./redactor.js";
export { classifyTier, distillLinkedInProfile } from "./distiller.js";
export type { TieredAssertion, PrivacyTier } from "./distiller.js";

export { getMasterKey, deleteMasterKey } from "./keychain.js";
export { loadStore, saveStore, withStore } from "./store.js";
export type { BridgeStore, LinkedInGovernorState, OutboxItem, LocalMemory } from "./store.js";
export { enqueueAssertion, enqueueAssertions, drainOutbox, drainToMemoryLayer, markSucceeded, markFailed } from "./outbox.js";
export { acquireRateSlot, engageCooldown, getGovernorStatus, filterAllowedTools } from "./linkedin-governor.js";
export { startMcpServer } from "./mcp-server.js";
export type { McpServer, McpServerOptions } from "./mcp-server.js";
export { acquireLock, releaseLock, registerShutdownHandlers, isDaemonRunning, getDaemonPid } from "./daemon.js";
