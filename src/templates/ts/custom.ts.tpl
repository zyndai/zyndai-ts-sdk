/**
 * __AGENT_NAME__ — Custom Agent on the ZyndAI Network
 *
 * Install dependencies:
 *   npm install zyndai
 *
 * Run:
 *   npx tsx agent.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import { ZyndAIAgent, AgentConfigSchema, AgentMessage } from "zyndai";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

async function handleRequest(query: string): Promise<string> {
  // Your agent logic here. Replace this with your own implementation.
  return `Hello from __AGENT_NAME__! You asked: ${query}`;
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a custom agent on the ZyndAI network.",
    capabilities: {
      ai: ["custom"],
      protocols: ["http"],
    },
    category: _config.category ?? "general",
    tags: _config.tags ?? [],
    summary: _config.summary ?? "__AGENT_NAME__ agent",
    webhookHost: "0.0.0.0",
    webhookPort: _config.webhook_port ?? 5000,
    registryUrl:
      process.env.ZYND_REGISTRY_URL ??
      _config.registry_url ??
      "http://localhost:8080",
    keypairPath:
      process.env.ZYND_AGENT_KEYPAIR_PATH ?? _config.keypair_path,
    entityUrl: process.env.ZYND_ENTITY_URL ?? _config.entity_url,
    price: _config.price,
    entityPricing: _config.entity_pricing ?? undefined,
    entityIndex: _config.entity_index ?? 0,
  });

  const zyndAgent = new ZyndAIAgent(agentConfig, {
    payloadModel: RequestPayload,
    outputModel: ResponsePayload,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  });
  zyndAgent.setCustomAgent(handleRequest);

  zyndAgent.webhook.addMessageHandler(async (message: AgentMessage) => {
    try {
      const response = await zyndAgent.invoke(message.content);
      zyndAgent.webhook.setResponse(message.messageId, response);
    } catch (e) {
      zyndAgent.webhook.setResponse(
        message.messageId,
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  await zyndAgent.start();

  console.log(`\n__AGENT_NAME__ is running`);
  console.log(`Webhook: ${zyndAgent.webhookUrl}`);
  console.log("Type 'exit' to quit\n");

  process.stdin.on("data", (buf) => {
    if (buf.toString().trim().toLowerCase() === "exit") process.exit(0);
  });
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
