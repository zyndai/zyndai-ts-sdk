/** __AGENT_NAME__ — LangChain.js Agent on the Zynd network.
 *
 * npm install zyndai @langchain/openai @langchain/community @langchain/core langchain
 */

import "dotenv/config";
import * as fs from "node:fs";
import {
  ZyndAIAgent,
  AgentConfigSchema,
  resolveRegistryUrl,
  A2AClient,
  SearchAndDiscoveryManager,
  type HandlerInput,
  type TaskHandle,
} from "zyndai";

import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

function buildLangchainAgent(zyndAgent: ZyndAIAgent, registryUrl: string) {
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
  const search = new SearchAndDiscoveryManager(registryUrl);
  const a2aClient = new A2AClient({
    keypair: zyndAgent.keypair,
    entityId: zyndAgent.entityId,
    fqan: _config.fqan,
  });

  const hello = tool(
    async ({ query }: { query: string }) => `Hello! You asked: ${query}`,
    {
      name: "hello",
      description: "A simple demo tool. Replace with your own.",
      schema: z.object({ query: z.string() }),
    },
  );

  const searchAgents = tool(
    async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await search.searchByKeyword(query, limit ?? 5);
      return JSON.stringify(
        results.map((r) => ({
          entity_id: r.entity_id,
          name: r.name,
          summary: r.summary,
          entity_url: r.entity_url,
          fqan: (r as { fqan?: string }).fqan,
          tags: r.tags,
        })),
        null,
        2,
      );
    },
    {
      name: "search_agents",
      description: "Search the Zynd registry for other agents by keyword.",
      schema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
    },
  );

  const callAgent = tool(
    async ({ entity_url, message }: { entity_url: string; message: string }) => {
      return a2aClient.ask(entity_url, message);
    },
    {
      name: "call_agent",
      description:
        "Send an A2A message to another agent. Pass the agent's card URL, base URL, or A2A endpoint URL.",
      schema: z.object({
        entity_url: z.string(),
        message: z.string(),
      }),
    },
  );

  const tools = [hello, new TavilySearchResults({ maxResults: 3 }), searchAgents, callAgent];

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are __AGENT_NAME__, a helpful AI assistant. " +
        "Use `search_agents` to discover other agents and `call_agent` to talk to them. " +
        "Use `tavily_search_results_json` when you don't know something — do not say 'I don't know'.",
    ],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  return new AgentExecutor({
    agent: createToolCallingAgent({ llm, tools, prompt }),
    tools,
    verbose: false,
    maxIterations: 3,
  });
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description: _config.description ?? "__AGENT_NAME__ — a LangChain.js agent on the Zynd network.",
    version: _config.version ?? "0.1.0",
    category: _config.category ?? "general",
    tags: _config.tags ?? ["langchain"],
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

  zyndAgent.setLangchainAgent(buildLangchainAgent(zyndAgent, agentConfig.registryUrl));

  const conversations = new Map<string, BaseMessage[]>();
  const lastSeen = new Map<string, number>();
  const CTX_HISTORY_TURNS = 10;
  const CTX_IDLE_MS = 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - CTX_IDLE_MS;
    for (const [ctxId, ts] of lastSeen) {
      if (ts < cutoff) {
        conversations.delete(ctxId);
        lastSeen.delete(ctxId);
      }
    }
  }, 5 * 60 * 1000).unref?.();

  zyndAgent.onMessage(async (input: HandlerInput, task: TaskHandle) => {
    const ctxId = task.contextId;
    let history = conversations.get(ctxId) ?? [];
    lastSeen.set(ctxId, Date.now());

    try {
      const response = await zyndAgent.invoke(input.message.content, { chat_history: history });
      history.push(new HumanMessage(input.message.content), new AIMessage(response));
      const cap = CTX_HISTORY_TURNS * 2;
      if (history.length > cap) history = history.slice(-cap);
      conversations.set(ctxId, history);
      return { response };
    } catch (e) {
      return task.fail(e instanceof Error ? e.message : String(e));
    }
  });

  await zyndAgent.start();

  console.log(`\n__AGENT_NAME__ is running (LangChain.js)`);
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
