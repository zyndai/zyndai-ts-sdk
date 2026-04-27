/**
 * __AGENT_NAME__ — Vercel AI SDK Agent on the ZyndAI Network
 *
 * Install dependencies:
 *   npm install zyndai ai @ai-sdk/openai zod
 *
 * Run:
 *   npx tsx agent.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import { ZyndAIAgent, AgentConfigSchema, AgentMessage } from "zyndai";

import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

const hello = tool({
  description: "A simple demo tool. Replace with your own tools.",
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => `Hello! You asked: ${query}`,
});

// Duck-typed to the VercelAiLike interface: async .generateText({ prompt }) -> { text }.
interface VercelAgent {
  generateText(opts: { prompt: string }): Promise<{ text: string }>;
}

function createAgent(): VercelAgent {
  const model = openai("gpt-4o-mini");

  return {
    async generateText({ prompt }) {
      const { text } = await generateText({
        model,
        system: "You are __AGENT_NAME__, a helpful AI assistant.",
        prompt,
        tools: { hello },
        maxSteps: 5,
      });
      return { text };
    },
  };
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a Vercel AI SDK agent on the ZyndAI network.",
    capabilities: {
      ai: ["nlp", "vercel_ai", "tool_use"],
      protocols: ["http"],
    },
    category: _config.category ?? "general",
    tags: _config.tags ?? ["vercel-ai"],
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
  const vercelAgent = createAgent();
  zyndAgent.setVercelAiAgent(vercelAgent);

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

  console.log(`\n__AGENT_NAME__ is running (Vercel AI SDK)`);
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
