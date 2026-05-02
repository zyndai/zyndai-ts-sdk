/** __AGENT_NAME__ — Vercel AI SDK Agent on the Zynd network.
 *
 * npm install zyndai ai @ai-sdk/openai zod
 */

import "dotenv/config";
import * as fs from "node:fs";
import {
  ZyndAIAgent,
  AgentConfigSchema,
  resolveRegistryUrl,
  type HandlerInput,
  type TaskHandle,
} from "zyndai";

import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

const hello = tool({
  description: "A simple demo tool. Replace with your own.",
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => `Hello! You asked: ${query}`,
});

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
    description: _config.description ?? "__AGENT_NAME__ — a Vercel AI SDK agent on the Zynd network.",
    version: _config.version ?? "0.1.0",
    category: _config.category ?? "general",
    tags: _config.tags ?? ["vercel-ai"],
    serverHost: _config.server_host ?? "0.0.0.0",
    serverPort: Number(process.env.ZYND_SERVER_PORT ?? _config.server_port ?? _config.webhook_port ?? 5000),
    authMode: _config.auth_mode ?? "permissive",
    registryUrl: resolveRegistryUrl({ fromConfigFile: _config.registry_url }),
    keypairPath: process.env.ZYND_AGENT_KEYPAIR_PATH ?? _config.keypair_path,
    entityUrl: process.env.ZYND_ENTITY_URL ?? _config.entity_url,
    price: _config.price,
    entityPricing: _config.entity_pricing ?? undefined,
    entityIndex: _config.entity_index ?? 0,
    skills: _config.skills,
    fqan: _config.fqan,
  });

  const zyndAgent = new ZyndAIAgent(agentConfig, {
    payloadModel: RequestPayload,
    outputModel: ResponsePayload,
    maxBodyBytes: MAX_FILE_SIZE_BYTES,
  });
  zyndAgent.setVercelAiAgent(createAgent());

  zyndAgent.onMessage(async (input: HandlerInput, task: TaskHandle) => {
    try {
      return { response: await zyndAgent.invoke(input.message.content) };
    } catch (e) {
      return task.fail(e instanceof Error ? e.message : String(e));
    }
  });

  await zyndAgent.start();

  console.log(`\n__AGENT_NAME__ is running (Vercel AI SDK)`);
  console.log(`A2A endpoint: ${zyndAgent.a2aUrl}`);
  console.log(`Agent card:   ${zyndAgent.cardUrl}`);

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
