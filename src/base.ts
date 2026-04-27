import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import chalk from "chalk";
import { z } from "zod";
import type { ZyndBaseConfig } from "./types.js";
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
import { resolveKeypair, resolveCardFromConfig, buildRuntimeCard } from "./entity-card-loader.js";
import type { StaticEntityCard } from "./entity-card-loader.js";
import { X402PaymentProcessor } from "./payment.js";
import { SearchAndDiscoveryManager } from "./search.js";
import { WebhookCommunicationManager } from "./webhook.js";
import { buildEntityUrl } from "./config-manager.js";
import { zodSchemaAdvertisement } from "./payload-schema.js";
import { registerEntity, getEntity, updateEntity } from "./registry.js";

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

/**
 * Runtime payload validation options. The TS analog of
 * (payload_model=, output_model=, max_file_size_bytes=) from the Python
 * SDK's ZyndAIAgent/ZyndService constructors.
 */
export interface ValidationOptions {
  /** Zod schema validated against every inbound /webhook body. */
  payloadModel?: z.ZodTypeAny;
  /** Zod schema validated against every handler response before it's shipped. */
  outputModel?: z.ZodTypeAny;
  /** Max POST body size in bytes — caps inline base64 attachments. Defaults to 25 MiB. */
  maxFileSizeBytes?: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_RECONNECT_DELAY_MS = 5_000;

export class ZyndBase {
  protected _entityLabel = "ZYND ENTITY";
  protected _entityType = "agent";

  readonly config: ZyndBaseConfig;
  readonly keypair: Ed25519Keypair;
  readonly entityId: string;
  readonly x402Processor: X402PaymentProcessor;
  readonly payToAddress: string;
  readonly search: SearchAndDiscoveryManager;
  readonly webhook: WebhookCommunicationManager;

  private readonly staticCard: StaticEntityCard;
  private readonly cardBuilder: () => Record<string, unknown>;
  private readonly validation: ValidationOptions;
  private heartbeatWs: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatStopped = false;

  constructor(config: ZyndBaseConfig, validation: ValidationOptions = {}) {
    this.config = ZyndBaseConfigSchema.parse(config);
    this.validation = validation;

    this.keypair = resolveKeypair({
      keypairPath: this.config.keypairPath,
      configDir: this.config.configDir,
    });

    this.entityId = generateEntityId(
      this.keypair.publicKeyBytes,
      this._entityType,
    );

    this.x402Processor = new X402PaymentProcessor({
      ed25519PrivateKeyBytes: this.keypair.privateKeyBytes,
    });
    this.payToAddress = this.x402Processor.address;

    this.search = new SearchAndDiscoveryManager(this.config.registryUrl);

    this.staticCard = resolveCardFromConfig(this.config);

    // Precompute the schema advertisement once — JSON-Schema conversion is
    // non-trivial and the shape only changes when the developer edits
    // payload.ts, which triggers a process restart anyway.
    const schemaAd = zodSchemaAdvertisement(
      this.validation.payloadModel,
      this.validation.outputModel,
    );

    this.cardBuilder = (): Record<string, unknown> => {
      const baseUrl = this.getBaseUrl();
      const card = buildRuntimeCard(this.staticCard, baseUrl, this.keypair);
      const result: Record<string, unknown> = { ...card };
      if (this._entityType === "service") {
        result["entity_type"] = "service";
      }
      if (schemaAd.input_schema) result["input_schema"] = schemaAd.input_schema;
      if (schemaAd.output_schema) result["output_schema"] = schemaAd.output_schema;
      if (schemaAd.accepts_files) result["accepts_files"] = true;
      return result;
    };

    const runtimePrice = this.resolveRuntimePrice();

    this.webhook = new WebhookCommunicationManager({
      entityId: this.entityId,
      webhookHost: this.config.webhookHost,
      webhookPort: this.config.webhookPort,
      webhookUrl: this.config.webhookUrl,
      keypair: this.keypair,
      agentCardBuilder: this.cardBuilder,
      price: runtimePrice,
      payToAddress: this.payToAddress,
      messageHistoryLimit: this.config.messageHistoryLimit,
      payloadModel: this.validation.payloadModel,
      outputModel: this.validation.outputModel,
      maxFileSizeBytes: this.validation.maxFileSizeBytes,
    });
  }

  /**
   * Convenience accessor — mirrors `zynd_agent.webhook_url` on the Python SDK.
   * Templates reference this directly after `await agent.start()` to print the
   * listen URL.
   */
  get webhookUrl(): string {
    return this.webhook.webhookUrl;
  }

  async start(): Promise<void> {
    await this.webhook.start();
    this.writeCardFile();
    await this.upsertOnRegistry();
    this.startHeartbeat();
    this.displayInfo();
  }

  /**
   * Register this entity if it doesn't exist on the registry, or update its
   * record if it does. Mirrors the Python `zynd <kind> run` upsert flow but
   * runs in-process so a plain `tsx agent.ts` (or `node agent.js`) gets the
   * same behavior as `zynd agent run`.
   *
   * If the developer keypair (~/.zynd/developer.json or
   * ZYND_DEVELOPER_KEYPAIR_PATH) is missing, registration is skipped with a
   * warning — this lets containerized deployments where only the agent key
   * ships still start the webhook + heartbeat.
   */
  private async upsertOnRegistry(): Promise<void> {
    const devKeyPath = defaultDeveloperKeyPath();
    if (!fs.existsSync(devKeyPath)) {
      console.log(
        chalk.yellow(
          `[registry] developer keypair not found at ${devKeyPath} — skipping auto-register. ` +
            `Run 'zynd init' or set ZYND_DEVELOPER_KEYPAIR_PATH.`,
        ),
      );
      return;
    }

    const devKp = loadKeypair(devKeyPath);
    const devId = generateDeveloperId(devKp.publicKeyBytes);
    const entityIndex = this.config.entityIndex ?? 0;
    const proof = createDerivationProof(
      devKp,
      this.keypair.publicKeyBytes,
      entityIndex,
    );
    const entityUrl = this.getBaseUrl();
    const entityName = slugifyName(this.config.name || "", `-${this._entityType}`);
    const entityPricing = this.config.entityPricing
      ? {
          base_price_usd: this.config.entityPricing.base_price_usd,
          currency: this.config.entityPricing.currency,
        }
      : undefined;

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

    if (existing) {
      console.log(chalk.dim(`[registry] ${this._entityType} already registered — updating...`));
      try {
        await updateEntity({
          registryUrl: this.config.registryUrl,
          entityId: this.entityId,
          keypair: this.keypair,
          fields: {
            name: this.config.name,
            entity_url: entityUrl,
            category: this.config.category,
            tags: this.config.tags ?? [],
            summary: this.config.summary ?? "",
          },
        });
        console.log(
          chalk.hex("#8B5CF6")(`[registry] ✓ updated ${this.entityId}`),
        );
      } catch (err) {
        console.log(
          chalk.red(
            `[registry] update failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      return;
    }

    console.log(chalk.dim(`[registry] registering new ${this._entityType}...`));
    try {
      const registeredId = await registerEntity({
        registryUrl: this.config.registryUrl,
        keypair: this.keypair,
        name: this.config.name,
        entityUrl,
        category: this.config.category,
        tags: this.config.tags ?? [],
        summary: this.config.summary ?? "",
        entityType: this._entityType,
        entityName,
        entityPricing: entityPricing as Record<string, unknown> | undefined,
        developerId: devId,
        developerProof: proof as unknown as Record<string, unknown>,
      });
      console.log(
        chalk.hex("#8B5CF6")(`[registry] ✓ registered ${registeredId}`),
      );
    } catch (err) {
      console.log(
        chalk.red(
          `[registry] register failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    await this.webhook.stop();
  }

  private getBaseUrl(): string {
    const url = buildEntityUrl(this.config);
    if (url.endsWith("/webhook")) return url.slice(0, -"/webhook".length);
    return url.replace(/\/+$/, "");
  }

  private resolveRuntimePrice(): string | undefined {
    if (this.config.price) return this.config.price;

    if (this.config.entityPricing) {
      const base = this.config.entityPricing.base_price_usd;
      if (typeof base === "number" && base > 0) {
        const currency = this.config.entityPricing.currency || "USDC";
        return `$${base} ${currency}`;
      }
    }

    return undefined;
  }

  private writeCardFile(): void {
    try {
      const card = this.cardBuilder();
      const cardPath = this.config.cardOutput || path.join(".well-known", "agent.json");
      const cardDir = path.dirname(cardPath);
      if (cardDir) fs.mkdirSync(cardDir, { recursive: true });
      fs.writeFileSync(cardPath, JSON.stringify(card, null, 2));
    } catch {
      // Card file write is best-effort; the card is still served via HTTP.
    }
  }

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
      console.log(chalk.dim(`[heartbeat] connected (interval ${HEARTBEAT_INTERVAL_MS / 1000}s)`));
      this.sendHeartbeat(ws);
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat(ws);
      }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on("error", (err: Error) => {
      console.log(chalk.yellow(`[heartbeat] ws error: ${err.message}`));
      // Reconnect handled in close handler — error always precedes close.
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
    const timestamp = new Date().toISOString();
    const signature = sign(
      this.keypair.privateKeyBytes,
      new TextEncoder().encode(timestamp),
    );
    ws.send(JSON.stringify({ timestamp, signature }));
    console.log(chalk.dim(`[heartbeat] sent @ ${timestamp}`));
  }

  private scheduleHeartbeatReconnect(): void {
    if (this.heartbeatStopped) return;
    setTimeout(() => this.connectHeartbeatWs(), HEARTBEAT_RECONNECT_DELAY_MS);
  }

  private displayInfo(): void {
    const name = this.config.name || "Unnamed";
    const price = this.resolveRuntimePrice() || "Free";
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
    console.log(`  ${chalk.dim("Webhook")}      ${chalk.hex("#10B981")(this.webhook.webhookUrl)}`);
    console.log(`  ${chalk.dim("Price")}        ${price}`);
    console.log();
  }
}
