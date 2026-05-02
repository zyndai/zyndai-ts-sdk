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
import {
  ZyndService,
  ServiceConfigSchema,
  resolveRegistryUrl,
} from "zyndai";

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
    version: _config.version ?? "0.1.0",
    category: _config.category ?? "general",
    tags: _config.tags ?? [],
    serviceEndpoint: _config.service_endpoint,
    openapiUrl: _config.openapi_url,
    serverHost: _config.server_host ?? "0.0.0.0",
    serverPort: Number(process.env.ZYND_SERVER_PORT ?? _config.server_port ?? 5000),
    authMode: _config.auth_mode ?? "permissive",
    registryUrl: resolveRegistryUrl({ fromConfigFile: _config.registry_url }),
    keypairPath: process.env.ZYND_SERVICE_KEYPAIR_PATH ?? _config.keypair_path,
    entityUrl: process.env.ZYND_ENTITY_URL ?? _config.entity_url,
    price: _config.price,
    entityPricing: _config.entity_pricing ?? undefined,
    entityIndex: _config.entity_index ?? 0,
    skills: _config.skills,
    fqan: _config.fqan,
  });

  const service = new ZyndService(config, {
    payloadModel: RequestPayload,
    outputModel: ResponsePayload,
    maxBodyBytes: MAX_FILE_SIZE_BYTES,
  });

  // ZyndService.setHandler() takes a string-in / string-out callback. The SDK
  // wraps it in an A2A handler internally — extracts text from the inbound
  // message, calls your function, and ships the return value as the task's
  // artifact. No need to read task.history or call setResponse manually.
  service.setHandler(handleRequest);

  await service.start();

  console.log(`\n__SERVICE_NAME__ is running (A2A)`);
  console.log(`A2A endpoint: ${service.a2aUrl}`);
  console.log(`Agent card:   ${service.cardUrl}`);

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
