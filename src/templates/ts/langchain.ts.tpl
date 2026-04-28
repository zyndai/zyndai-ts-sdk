/**
 * __AGENT_NAME__ — LangChain.js Agent on the ZyndAI Network
 *
 * Install dependencies:
 *   npm install zyndai @langchain/openai @langchain/community @langchain/core langchain
 *
 * Run:
 *   npx tsx agent.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import { ZyndAIAgent, AgentConfigSchema, AgentMessage } from "zyndai";

import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { z } from "zod";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

// Load agent.config.json for runtime settings
const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

const hello = tool(
  async ({ query }: { query: string }) => `Hello! You asked: ${query}`,
  {
    name: "hello",
    description: "A simple demo tool. Replace with your own tools.",
    schema: z.object({ query: z.string() }),
  },
);

async function createAgent() {
  const llm = new ChatOpenAI({ model: "gpt-3.5-turbo", temperature: 0 });

  const searchTool = new TavilySearchResults({ maxResults: 3 });
  const tools = [hello, searchTool];

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are __AGENT_NAME__, a helpful AI assistant."],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = await createToolCallingAgent({ llm, tools, prompt });
  return new AgentExecutor({ agent, tools, verbose: true });
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a LangChain.js agent on the ZyndAI network.",
    capabilities: {
      ai: ["nlp", "langchain"],
      protocols: ["http"],
    },
    category: _config.category ?? "general",
    tags: _config.tags ?? ["langchain"],
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
  const executor = await createAgent();
  zyndAgent.setLangchainAgent(executor);

  zyndAgent.webhook.addMessageHandler(async (message: AgentMessage) => {
    try {
      const response = await zyndAgent.invoke(message.content, { chat_history: [] });
      zyndAgent.webhook.setResponse(message.messageId, response);
    } catch (e) {
      zyndAgent.webhook.setResponse(
        message.messageId,
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  await zyndAgent.start();

  console.log(`\n__AGENT_NAME__ is running (LangChain.js)`);
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
