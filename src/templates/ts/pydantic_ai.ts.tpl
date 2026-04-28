/**
 * __AGENT_NAME__ — PydanticAI-style Typed Agent on the ZyndAI Network
 *
 * PydanticAI is Python-only. This template implements the same contract —
 * strongly-typed, schema-validated outputs — using Zod + Vercel AI SDK's
 * `generateObject()`. The wrapper exposes `.run(input)` returning `{ data }`
 * so ZyndAIAgent.setPydanticAiAgent() can dispatch to it unchanged.
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

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

// Edit this schema to declare the shape PydanticAI-style agents should return.
// The SDK dispatcher reads `.data` off the result and stringifies it on the wire.
const OutputSchema = z.object({
  answer: z.string().describe("The direct answer to the user's question."),
  confidence: z.number().min(0).max(1).describe("Confidence in the answer, 0 to 1."),
});

type Output = z.infer<typeof OutputSchema>;

// Duck-typed to match the PydanticAiLike interface expected by
// ZyndAIAgent.setPydanticAiAgent(): async .run(input) -> { data }.
interface TypedAgent {
  run(input: string): Promise<{ data: Output }>;
}

function createAgent(): TypedAgent {
  const model = openai("gpt-4o-mini");

  return {
    async run(input: string) {
      const { object } = await generateObject({
        model,
        schema: OutputSchema,
        system: "You are __AGENT_NAME__, a helpful AI assistant.",
        prompt: input,
      });
      return { data: object };
    },
  };
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a PydanticAI-style typed agent on the ZyndAI network.",
    capabilities: {
      ai: ["nlp", "pydantic_ai", "structured_output"],
      protocols: ["http"],
    },
    category: _config.category ?? "general",
    tags: _config.tags ?? ["pydantic-ai", "zod"],
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
  const typedAgent = createAgent();
  zyndAgent.setPydanticAiAgent(typedAgent);

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

  console.log(`\n__AGENT_NAME__ is running (PydanticAI-style)`);
  console.log(`Webhook: ${zyndAgent.webhookUrl}`);

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
