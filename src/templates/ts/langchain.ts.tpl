/**
 * __AGENT_NAME__ — LangChain.js Agent on the Zynd network (A2A protocol).
 *
 * Install dependencies:
 *   npm install zyndai @langchain/openai @langchain/community @langchain/core langchain
 *
 * Run:
 *   npx tsx agent.ts
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

// Load agent.config.json for runtime settings
const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

// ---------------------------------------------------------------------------
// LangChain agent (LLM + tools)
// ---------------------------------------------------------------------------

function buildLangchainAgent(zyndAgent: ZyndAIAgent, registryUrl: string) {
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });

  // SDK clients reused by the tools below.
  const search = new SearchAndDiscoveryManager(registryUrl);
  const a2aClient = new A2AClient({
    keypair: zyndAgent.keypair,
    entityId: zyndAgent.entityId,
    fqan: _config.fqan,
  });

  // Demo tools. Replace these with your real ones.

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
      description:
        "Search the Zynd registry for other agents by keyword. Returns name, summary, entity_url (when available), and fqan for each match.",
      schema: z.object({
        query: z.string().describe("Free-text search keyword"),
        limit: z.number().optional().describe("Max results (default 5)"),
      }),
    },
  );

  const callAgent = tool(
    async ({ entity_url, message }: { entity_url: string; message: string }) => {
      // client.ask() does the right thing: fetches the agent card if needed,
      // sends a signed A2A message, reads the reply from task.artifacts
      // (NOT task.history — that contains your own outbound message echoed
      // back, which causes the LLM to loop on the tool).
      return a2aClient.ask(entity_url, message);
    },
    {
      name: "call_agent",
      description:
        "Send an A2A message to another agent. Pass the agent's card URL (ending in /.well-known/agent-card.json), its base URL (e.g. http://localhost:5000), or its A2A endpoint URL (e.g. http://localhost:5000/a2a/v1). Returns the agent's reply text.",
      schema: z.object({
        entity_url: z.string().describe("Agent card URL, base URL, or A2A endpoint"),
        message: z.string().describe("Message to send to that agent"),
      }),
    },
  );

  const tools = [hello, new TavilySearchResults({ maxResults: 3 }), searchAgents, callAgent];

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are __AGENT_NAME__, a helpful AI assistant. " +
        "Use `search_agents` to discover other agents on the Zynd network and " +
        "`call_agent` to talk to them over A2A.",
    ],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = createToolCallingAgent({ llm, tools, prompt });
  return new AgentExecutor({
    agent,
    tools,
    verbose: false,
    // Hard ceiling on tool-call iterations per invocation. Without this
    // a chatty LLM can drain your model quota chaining call_agent →
    // search → call_agent → ... until LangChain's default cap (15).
    maxIterations: 3,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a LangChain.js agent on the Zynd network.",
    version: _config.version ?? "0.1.0",
    category: _config.category ?? "general",
    tags: _config.tags ?? ["langchain"],
    serverHost: _config.server_host ?? "0.0.0.0",
    serverPort: Number(process.env.ZYND_SERVER_PORT ?? _config.server_port ?? 5000),
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

  const executor = buildLangchainAgent(zyndAgent, agentConfig.registryUrl);
  zyndAgent.setLangchainAgent(executor);

  // ---- Per-conversation memory for inbound A2A ----
  //
  // Keyed on A2A's `contextId` (NOT senderEntityId or taskId):
  //   - One sender can run multiple parallel conversations with us; each
  //     contextId is its own conversation, so each gets its own history.
  //   - One conversation can spawn multiple tasks (e.g. an input-required
  //     loopback creates a new taskId in the same context); they share
  //     history because they share contextId.
  //   - Idle conversations are GC'd after CTX_IDLE_MS so abandoned
  //     contextIds don't leak memory. For multi-replica deployments push
  //     this Map into Redis keyed on contextId.
  const conversations = new Map<string, BaseMessage[]>();
  const lastSeenContext = new Map<string, number>();
  const CTX_HISTORY_TURNS = 10;
  const CTX_IDLE_MS = 60 * 60 * 1000; // 1h
  setInterval(() => {
    const cutoff = Date.now() - CTX_IDLE_MS;
    for (const [ctxId, ts] of lastSeenContext) {
      if (ts < cutoff) {
        conversations.delete(ctxId);
        lastSeenContext.delete(ctxId);
      }
    }
  }, 5 * 60 * 1000).unref?.();

  // A2A inbound — other agents talk to us through this handler.
  // Auth (signature, replay, expiry) is verified by the SDK BEFORE this
  // fires; if you want to see those rejections, watch the server's stdout
  // for "[a2a-server] dispatch threw:" lines or inspect HTTP responses.
  zyndAgent.onMessage(async (input: HandlerInput, task: TaskHandle) => {
    const ctxId = task.contextId;
    let history = conversations.get(ctxId) ?? [];
    lastSeenContext.set(ctxId, Date.now());

    try {
      const response = await zyndAgent.invoke(input.message.content, {
        chat_history: history,
      });

      // Append this exchange and trim to the cap. Saving back into the Map
      // matters because we may have replaced `history` with a sliced copy.
      history.push(new HumanMessage(input.message.content), new AIMessage(response));
      const maxMessages = CTX_HISTORY_TURNS * 2;
      if (history.length > maxMessages) {
        history = history.slice(-maxMessages);
      }
      conversations.set(ctxId, history);

      // Return the response — SDK auto-calls task.complete() with this value.
      // The output is validated against ResponsePayload before shipping.
      return { response };
    } catch (e) {
      return task.fail(e instanceof Error ? e.message : String(e));
    }
  });

  await zyndAgent.start();

  console.log(`\n__AGENT_NAME__ is running (LangChain.js, A2A)`);
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
