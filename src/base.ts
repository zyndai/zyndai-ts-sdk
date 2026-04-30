import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import chalk from "chalk";
import { z } from "zod";
import type { ZyndBaseConfig, ServiceConfig } from "./types.js";
import { ZyndBaseConfigSchema } from "./types.js";
import {
  generateEntityId,
  generateDeveloperId,
  createDerivationProof,
  loadKeypair,
  defaultDeveloperKeyPath,
  sign,
  type Ed25519Keypair,
} from "./identity.js";
import {
  resolveKeypair,
  buildRuntimeCard,
  resolveProviderFromDeveloper,
} from "./entity-card-loader.js";
import type { AgentCardProvider } from "./a2a/card.js";
import { X402PaymentProcessor } from "./payment.js";
import { SearchAndDiscoveryManager } from "./search.js";
import { buildEntityUrl } from "./config-manager.js";
import { registerEntity, getEntity, updateEntity } from "./registry.js";
import { A2AServer, type Handler, type HandlerInput, type TaskHandle } from "./a2a/server.js";
import type { SignedAgentCard } from "./a2a/card.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Truncate a description into a search-result-friendly summary. Cuts at
 * the first sentence boundary or 160 chars (Twitter-card-ish), whichever
 * comes first. Whitespace-collapsed and trimmed.
 */
function summarize(text: string, maxLen = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= maxLen) return collapsed;
  const firstSentence = collapsed.match(/^(.{20,160}?[.!?])(\s|$)/);
  if (firstSentence) return firstSentence[1].trim();
  return collapsed.slice(0, maxLen - 1).trimEnd() + "…";
}

function slugifyName(name: string, shortSuffix = ""): string {
  let slug = name
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  slug = slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (slug.length < 3) slug = slug + shortSuffix;
  if (slug.length > 36) slug = slug.slice(0, 36);
  return slug;
}

function computeUpdateDiff(
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(desired)) {
    const want = desired[key];
    const have = existing[key];
    if (key === "tags") {
      const wantTags = Array.isArray(want) && want.length > 0 ? want : [];
      const haveTags = Array.isArray(have) && have.length > 0 ? have : [];
      if (JSON.stringify(wantTags) !== JSON.stringify(haveTags)) diff[key] = want;
    } else if (JSON.stringify(want) !== JSON.stringify(have ?? null)) {
      diff[key] = want;
    }
  }
  return diff;
}

// -----------------------------------------------------------------------------
// Validation options handed to the SDK by user code
// -----------------------------------------------------------------------------

export interface ValidationOptions {
  /** Zod schema validated against every inbound A2A request payload. */
  payloadModel?: z.ZodTypeAny;
  /** Zod schema validated against every handler response. */
  outputModel?: z.ZodTypeAny;
  /** Max inbound A2A request body in bytes. Defaults to config.maxBodyBytes. */
  maxBodyBytes?: number;
}

// -----------------------------------------------------------------------------
// ZyndBase
// -----------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_RECONNECT_DELAY_MS = 5_000;

export class ZyndBase {
  protected _entityLabel: string;
  protected _entityType: string;

  readonly config: ZyndBaseConfig;
  readonly keypair: Ed25519Keypair;
  readonly entityId: string;
  readonly x402Processor: X402PaymentProcessor;
  readonly payToAddress: string;
  readonly search: SearchAndDiscoveryManager;
  readonly server: A2AServer;

  private readonly validation: ValidationOptions;
  private readonly cardBuilder: () => SignedAgentCard;
  private resolvedProvider: AgentCardProvider | null = null;
  private heartbeatWs: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatStopped = false;

  constructor(
    config: ZyndBaseConfig,
    validation: ValidationOptions = {},
    entityType: string = "agent",
    entityLabel: string = "ZYND ENTITY",
  ) {
    this._entityType = entityType;
    this._entityLabel = entityLabel;
    this.config = ZyndBaseConfigSchema.parse(config);
    this.validation = validation;

    const keypairPath = this.config.keypairPath;
    const configDir = this.config.configDir;
    this.keypair = resolveKeypair({
      ...(keypairPath ? { keypairPath } : {}),
      ...(configDir ? { configDir } : {}),
    });

    this.entityId = generateEntityId(this.keypair.publicKeyBytes, this._entityType);

    this.x402Processor = new X402PaymentProcessor({
      ed25519PrivateKeyBytes: this.keypair.privateKeyBytes,
    });
    this.payToAddress = this.x402Processor.address;

    this.search = new SearchAndDiscoveryManager(this.config.registryUrl);

    // Build the agent-card lazily — we re-run on every fetch so dynamic
    // fields like timestamps stay fresh.
    this.cardBuilder = (): SignedAgentCard => {
      const baseUrl = this.getBaseUrl();
      const buildArgs: Parameters<typeof buildRuntimeCard>[0] = {
        config: this.config,
        baseUrl,
        keypair: this.keypair,
        entityId: this.entityId,
      };
      if (this.validation.payloadModel) buildArgs.payloadModel = this.validation.payloadModel;
      if (this.validation.outputModel) buildArgs.outputModel = this.validation.outputModel;
      if (this.resolvedProvider) buildArgs.fallbackProvider = this.resolvedProvider;
      return buildRuntimeCard(buildArgs);
    };

    const fqan = this.config.fqan;
    const a2aOpts: ConstructorParameters<typeof A2AServer>[0] = {
      entityId: this.entityId,
      keypair: this.keypair,
      agentCardBuilder: () => this.cardBuilder() as unknown as Record<string, unknown>,
      host: this.config.serverHost,
      port: this.config.serverPort,
      a2aPath: this.config.a2aPath,
      authMode: this.config.authMode,
      maxBodyBytes: validation.maxBodyBytes ?? this.config.maxBodyBytes,
    };
    if (fqan) a2aOpts.fqan = fqan;
    if (validation.payloadModel) a2aOpts.payloadModel = validation.payloadModel;
    if (validation.outputModel) a2aOpts.outputModel = validation.outputModel;

    this.server = new A2AServer(a2aOpts);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  get a2aUrl(): string {
    return this.server.a2aUrl;
  }
  get cardUrl(): string {
    return `${this.getBaseUrl()}/.well-known/agent-card.json`;
  }

  /**
   * Register the handler that runs for every inbound message/send and
   * message/stream call. Subclasses expose a friendlier surface
   * (`onMessage` for agents, overloaded `setHandler` for services).
   */
  protected installHandler(fn: Handler): void {
    this.server.setHandler(fn);
  }

  async start(): Promise<void> {
    await this.server.start();
    // Resolve the provider block from the developer keypair + registry
    // BEFORE writing the card file so the on-disk copy carries the
    // auto-populated organization/url. Failures are non-fatal: a missing
    // developer key or an unreachable registry just means the card ships
    // without a provider block.
    await this.resolveProvider();
    this.writeCardFile();
    await this.upsertOnRegistry();
    this.startHeartbeat();
    this.displayInfo();
  }

  private async resolveProvider(): Promise<void> {
    try {
      this.resolvedProvider = await resolveProviderFromDeveloper({
        registryUrl: this.config.registryUrl,
      });
    } catch {
      this.resolvedProvider = null;
    }
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    await this.server.stop();
  }

  // ---------------------------------------------------------------------------
  // Registry upsert
  // ---------------------------------------------------------------------------

  private async upsertOnRegistry(): Promise<void> {
    const devKeyPath = defaultDeveloperKeyPath();
    const hasDevKey = fs.existsSync(devKeyPath);

    const entityUrl = this.getBaseUrl();
    const entityName = slugifyName(this.config.name || "", `-${this._entityType}`);
    const entityPricing = this.config.entityPricing
      ? {
          base_price_usd: this.config.entityPricing.base_price_usd,
          currency: this.config.entityPricing.currency,
        }
      : undefined;

    let serviceEndpoint: string | undefined;
    let openapiUrl: string | undefined;
    if (this._entityType === "service") {
      const svc = this.config as Partial<ServiceConfig>;
      serviceEndpoint = svc.serviceEndpoint || entityUrl;
      openapiUrl = svc.openapiUrl;
    }

    if (this.isLoopbackUrl(entityUrl)) {
      console.log(
        chalk.yellow(
          `[registry] entity_url ${entityUrl} is a loopback address — the registry and other agents will not be able to reach this ${this._entityType}. ` +
            `Set ZyndBaseConfig.entityUrl to a publicly reachable URL before going live.`,
        ),
      );
    }

    let existing: Record<string, unknown> | null;
    try {
      existing = await getEntity(this.config.registryUrl, this.entityId);
    } catch (err) {
      console.log(
        chalk.yellow(
          `[registry] lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    const desiredFields: Record<string, unknown> = {
      name: this.config.name,
      entity_url: entityUrl,
      category: this.config.category,
      tags: this.config.tags ?? [],
      // The registry's `summary` field is what shows up in search-result
      // snippets — it should be a short one-liner. We derive it from
      // `description` rather than asking users to maintain a second prose
      // field. `summarize()` truncates at the first sentence boundary, or
      // 160 chars, whichever is shorter. When description is empty we
      // fall back to the agent name so search results are never blank.
      summary: summarize(this.config.description ?? "") || this.config.name,
    };
    if (serviceEndpoint) desiredFields["service_endpoint"] = serviceEndpoint;
    if (openapiUrl) desiredFields["openapi_url"] = openapiUrl;

    const tryUpdate = async (updateFields: Record<string, unknown>): Promise<boolean> => {
      try {
        await updateEntity({
          registryUrl: this.config.registryUrl,
          entityId: this.entityId,
          keypair: this.keypair,
          fields: updateFields,
        });
        const changedKeys = Object.keys(updateFields).join(", ");
        console.log(chalk.hex("#8B5CF6")(`[registry] ✓ updated ${this.entityId} (${changedKeys})`));
        return true;
      } catch (err) {
        console.log(
          chalk.red(
            `[registry] update failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return false;
      }
    };

    if (existing) {
      console.log(
        chalk.dim(`[registry] ${this._entityType} already registered — checking for changes...`),
      );
      const diff = computeUpdateDiff(existing, desiredFields);
      if (Object.keys(diff).length === 0) {
        console.log(chalk.hex("#8B5CF6").dim(`[registry] no changes — skipping update`));
        return;
      }
      await tryUpdate(diff);
      return;
    }

    if (!hasDevKey) {
      console.log(
        chalk.yellow(
          `[registry] entity not registered yet and developer keypair not found at ${devKeyPath} — ` +
            `skipping initial registration. Run 'zynd auth login --registry <url>' or set ZYND_DEVELOPER_KEYPAIR_PATH on the box that owns this entity.`,
        ),
      );
      return;
    }

    const devKp = loadKeypair(devKeyPath);
    const devId = generateDeveloperId(devKp.publicKeyBytes);
    const entityIndex = this.config.entityIndex ?? 0;
    const proof = createDerivationProof(devKp, this.keypair.publicKeyBytes, entityIndex);

    console.log(chalk.dim(`[registry] registering new ${this._entityType}...`));
    try {
      const registeredId = await registerEntity({
        registryUrl: this.config.registryUrl,
        keypair: this.keypair,
        name: this.config.name,
        entityUrl,
        category: this.config.category,
        tags: this.config.tags ?? [],
        summary: summarize(this.config.description ?? "") || this.config.name,
        entityType: this._entityType,
        entityName,
        entityPricing: entityPricing as Record<string, unknown> | undefined,
        developerId: devId,
        developerProof: proof as unknown as Record<string, unknown>,
        ...(serviceEndpoint ? { serviceEndpoint } : {}),
        ...(openapiUrl ? { openapiUrl } : {}),
      });
      console.log(chalk.hex("#8B5CF6")(`[registry] ✓ registered ${registeredId}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HTTP 409")) {
        console.log(
          chalk.yellow(
            `[registry] register returned 409 (entity already exists at this public key) — falling back to update...`,
          ),
        );
        await tryUpdate(desiredFields);
        return;
      }
      console.log(chalk.red(`[registry] register failed: ${msg}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Card file output
  // ---------------------------------------------------------------------------

  private writeCardFile(): void {
    try {
      const card = this.cardBuilder();
      const cardPath =
        this.config.cardOutput || path.join(".well-known", "agent-card.json");
      const cardDir = path.dirname(cardPath);
      if (cardDir) fs.mkdirSync(cardDir, { recursive: true });
      fs.writeFileSync(cardPath, JSON.stringify(card, null, 2));
    } catch {
      // Best-effort. Card is also served live via /.well-known/agent-card.json.
    }
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  private getBaseUrl(): string {
    return buildEntityUrl(this.config);
  }

  private isLoopbackUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.startsWith("127.")
      );
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatStopped = false;
    this.connectHeartbeatWs();
  }

  private stopHeartbeat(): void {
    this.heartbeatStopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatWs) {
      this.heartbeatWs.removeAllListeners();
      this.heartbeatWs.close();
      this.heartbeatWs = null;
    }
  }

  private connectHeartbeatWs(): void {
    if (this.heartbeatStopped) return;

    const wsUrl = this.config.registryUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");
    const endpoint = `${wsUrl}/v1/entities/${this.entityId}/ws`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint);
    } catch (err) {
      console.log(
        chalk.yellow(
          `[heartbeat] failed to open ws: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      this.scheduleHeartbeatReconnect();
      return;
    }

    console.log(chalk.dim(`[heartbeat] connecting ${endpoint}`));

    ws.on("open", () => {
      this.heartbeatWs = ws;
      console.log(
        chalk.dim(`[heartbeat] connected (interval ${HEARTBEAT_INTERVAL_MS / 1000}s)`),
      );
      this.sendHeartbeat(ws);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(ws), HEARTBEAT_INTERVAL_MS);
    });

    ws.on("error", (err: Error) => {
      console.log(chalk.yellow(`[heartbeat] ws error: ${err.message}`));
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.heartbeatWs = null;
      const reasonStr = reason?.length ? ` (${reason.toString()})` : "";
      console.log(
        chalk.dim(
          `[heartbeat] disconnected code=${code}${reasonStr} — reconnect in ${HEARTBEAT_RECONNECT_DELAY_MS / 1000}s`,
        ),
      );
      this.scheduleHeartbeatReconnect();
    });
  }

  private sendHeartbeat(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const signature = sign(this.keypair.privateKeyBytes, new TextEncoder().encode(timestamp));
    ws.send(JSON.stringify({ timestamp, signature }));
  }

  private scheduleHeartbeatReconnect(): void {
    if (this.heartbeatStopped) return;
    setTimeout(() => this.connectHeartbeatWs(), HEARTBEAT_RECONNECT_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  private displayInfo(): void {
    const name = this.config.name || "Unnamed";
    const price =
      this.config.price ??
      (this.config.entityPricing
        ? `$${this.config.entityPricing.base_price_usd} ${this.config.entityPricing.currency}`
        : "Free");
    const pubKey = this.keypair.publicKeyString;

    console.log();
    console.log(chalk.hex("#8B5CF6")(`  ${"=".repeat(56)}`));
    console.log(chalk.hex("#8B5CF6")(`  ${chalk.bold.white(this._entityLabel)}`));
    console.log(chalk.hex("#8B5CF6")(`  ${"=".repeat(56)}`));
    console.log();
    console.log(`  ${chalk.dim("Name")}         ${chalk.bold.white(name)}`);
    if (this.config.description) {
      console.log(`  ${chalk.dim("Description")}  ${this.config.description}`);
    }
    console.log(`  ${chalk.dim("ID")}           ${chalk.hex("#06B6D4")(this.entityId)}`);
    console.log(`  ${chalk.dim("Public Key")}   ${chalk.dim(pubKey)}`);
    console.log(`  ${chalk.dim("Address")}      ${chalk.dim(this.payToAddress)}`);
    console.log(`  ${chalk.dim("A2A")}          ${chalk.hex("#10B981")(this.a2aUrl)}`);
    console.log(`  ${chalk.dim("Card")}         ${chalk.hex("#10B981")(this.cardUrl)}`);
    console.log(`  ${chalk.dim("Price")}        ${price}`);
    console.log();
  }
}

// Re-export for convenience.
export type { Handler, HandlerInput, TaskHandle } from "./a2a/server.js";
