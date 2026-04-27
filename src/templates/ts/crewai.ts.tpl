/**
 * __AGENT_NAME__ — CrewAI-style Multi-Agent System on the ZyndAI Network
 *
 * CrewAI has no official TypeScript port, so this template implements the
 * researcher + analyst pattern with LangChain.js. The crew object exposes a
 * `.kickoff({ inputs })` method that returns `{ raw }` — the same shape
 * ZyndAIAgent.setCrewAgent() expects, so a drop-in replacement with the
 * community `crewai-ts` package (https://www.npmjs.com/package/crewai-ts)
 * will work without changes here.
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
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

// Minimal CrewLike shape. ZyndAIAgent.setCrewAgent() calls
// `crew.kickoff({ inputs })` and reads `{ raw }` off the result.
interface Crew {
  kickoff(args: { inputs?: Record<string, unknown> }): Promise<{ raw: string }>;
}

function createCrew(): Crew {
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
  const searchTool = new TavilySearchResults({ maxResults: 3 });

  // Researcher — gathers facts.
  const researcherPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are a Researcher. Goal: research and gather comprehensive data on the topic.",
    ],
    ["human", "Research the topic: {query}. Gather key data and facts."],
  ]);

  // Analyst — consumes researcher output and produces insight.
  const analystPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are a senior Analyst. Produce balanced, professional analysis.",
    ],
    [
      "human",
      "Research findings:\n{research}\n\nNow analyze and provide insights on: {query}",
    ],
  ]);

  const parser = new StringOutputParser();

  return {
    async kickoff({ inputs = {} }) {
      const query = String(inputs.query ?? "");

      // Step 1: researcher (with optional web search).
      let researchNotes: string;
      try {
        const hits = await searchTool.invoke(query);
        researchNotes = typeof hits === "string" ? hits : JSON.stringify(hits);
      } catch {
        researchNotes = "(no search tool output)";
      }

      const research = await researcherPrompt
        .pipe(llm)
        .pipe(parser)
        .invoke({ query: `${query}\n\nSearch results:\n${researchNotes}` });

      // Step 2: analyst.
      const analysis = await analystPrompt
        .pipe(llm)
        .pipe(parser)
        .invoke({ query, research });

      return { raw: analysis };
    },
  };
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ??
      "__AGENT_NAME__ — a CrewAI-style multi-agent system on the ZyndAI network.",
    capabilities: {
      ai: ["nlp", "crewai", "multi_agent"],
      protocols: ["http"],
    },
    category: _config.category ?? "general",
    tags: _config.tags ?? ["crewai", "multi-agent"],
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
  const crew = createCrew();
  zyndAgent.setCrewAgent(crew);

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

  console.log(`\n__AGENT_NAME__ is running (CrewAI-style)`);
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
