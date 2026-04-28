/**
 * __SERVICE_NAME__ — Service on the ZyndAI Network
 *
 * Install dependencies:
 *   npm install zyndai
 *
 * Run:
 *   npx tsx service.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import { ZyndService, ServiceConfigSchema, AgentMessage } from "zyndai";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("service.config.json")
  ? JSON.parse(fs.readFileSync("service.config.json", "utf-8"))
  : {};

/**
 * Your service logic here.
 *
 * Default contract per payload.ts: input is the `prompt` field as a string;
 * return value is wrapped into `{ response }` to match `ResponsePayload`.
 * Replace this with your own implementation.
 */
async function handleRequest(input: string): Promise<string> {
  return `Hello from __SERVICE_NAME__! You sent: ${input}`;
}

async function main() {
  const config = ServiceConfigSchema.parse({
    name: _config.name ?? "__SERVICE_NAME__",
    description: _config.description ?? "",
    capabilities: _config.capabilities,
    category: _config.category ?? "general",
    tags: _config.tags ?? [],
    summary: _config.summary ?? "__SERVICE_NAME__ service",
    serviceEndpoint: _config.service_endpoint,
    openapiUrl: _config.openapi_url,
    webhookHost: "0.0.0.0",
    webhookPort: _config.webhook_port ?? 5000,
    registryUrl:
      process.env.ZYND_REGISTRY_URL ??
      _config.registry_url ??
      "http://localhost:8080",
    keypairPath:
      process.env.ZYND_SERVICE_KEYPAIR_PATH ?? _config.keypair_path,
    entityUrl: process.env.ZYND_ENTITY_URL ?? _config.entity_url,
    price: _config.price,
    entityPricing: _config.entity_pricing ?? undefined,
    entityIndex: _config.entity_index ?? 0,
  });

  const service = new ZyndService(config, {
    payloadModel: RequestPayload,
    outputModel: ResponsePayload,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  });

  service.webhook.addMessageHandler(async (message: AgentMessage) => {
    try {
      const response = await handleRequest(message.content);
      service.webhook.setResponse(message.messageId, response);
    } catch (e) {
      service.webhook.setResponse(
        message.messageId,
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  await service.start();

  console.log(`\n__SERVICE_NAME__ is running`);
  console.log(`Webhook: ${service.webhookUrl}`);

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  if (process.stdin.isTTY) {
    console.log("Type 'exit' to quit\n");
    process.stdin.on("data", (buf) => {
      if (buf.toString().trim().toLowerCase() === "exit") process.exit(0);
    });
  } else {
    await new Promise<never>(() => {});
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`Error: ${String(err)}`);
  }
  process.exit(1);
});
