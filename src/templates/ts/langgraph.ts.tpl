/**
 * __AGENT_NAME__ — LangGraph.js Agent on the ZyndAI Network
 *
 * Install dependencies:
 *   npm install zyndai @langchain/openai @langchain/community @langchain/core @langchain/langgraph
 *
 * Run:
 *   npx tsx agent.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import { ZyndAIAgent, AgentConfigSchema, AgentMessage } from "zyndai";

import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

function createAgent() {
  const llm = new ChatOpenAI({ model: "gpt-3.5-turbo", temperature: 0 });

  const searchTool = new TavilySearchResults({ maxResults: 3 });
  const tools = [searchTool];
  const llmWithTools = llm.bindTools(tools);

  const agentNode = async (state: typeof MessagesAnnotation.State) => {
    const systemMessage = {
      role: "system",
      content: "You are __AGENT_NAME__, a helpful AI assistant.",
    };
    const messages = [systemMessage, ...state.messages];
    const response = await llmWithTools.invoke(messages);
    return { messages: [response] };
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent");

  return graph.compile();
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a LangGraph.js agent on the ZyndAI network.",
    capabilities: {
      ai: ["nlp", "langgraph"],
      protocols: ["http"],
    },
    category: _config.category ?? "general",
    tags: _config.tags ?? ["langgraph"],
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
  const compiled = createAgent();
  zyndAgent.setLanggraphAgent(compiled);

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

  console.log(`\n__AGENT_NAME__ is running (LangGraph.js)`);
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
