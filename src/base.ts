import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import chalk from "chalk";
import type { ZyndBaseConfig } from "./types.js";
import { ZyndBaseConfigSchema } from "./types.js";
import { generateEntityId, sign, type Ed25519Keypair } from "./identity.js";
import { resolveKeypair, resolveCardFromConfig, buildRuntimeCard } from "./entity-card-loader.js";
import type { StaticEntityCard } from "./entity-card-loader.js";
import { X402PaymentProcessor } from "./payment.js";
import { SearchAndDiscoveryManager } from "./search.js";
import { WebhookCommunicationManager } from "./webhook.js";
import { buildEntityUrl } from "./config-manager.js";

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
  private heartbeatWs: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatStopped = false;

  constructor(config: ZyndBaseConfig) {
    this.config = ZyndBaseConfigSchema.parse(config);

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

    this.cardBuilder = (): Record<string, unknown> => {
      const baseUrl = this.getBaseUrl();
      const card = buildRuntimeCard(this.staticCard, baseUrl, this.keypair);
      const result: Record<string, unknown> = { ...card };
      if (this._entityType === "service") {
        result["entity_type"] = "service";
      }
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
    this.startHeartbeat();
    this.displayInfo();
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
    } catch {
      this.scheduleHeartbeatReconnect();
      return;
    }

    ws.on("open", () => {
      this.heartbeatWs = ws;
      this.sendHeartbeat(ws);
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat(ws);
      }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on("error", () => {
      // Error events are followed by close events; reconnect happens there.
    });

    ws.on("close", () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.heartbeatWs = null;
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
