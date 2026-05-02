/** __AGENT_NAME__ — CrewAI-style Multi-Agent System on the Zynd network.
 *
 * npm install zyndai @langchain/openai @langchain/community @langchain/core langchain
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

import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

interface Crew {
  kickoff(args: { inputs?: Record<string, unknown> }): Promise<{ raw: string }>;
}

function createCrew(): Crew {
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
  const searchTool = new TavilySearchResults({ maxResults: 3 });
  const parser = new StringOutputParser();

  const researcherPrompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a Researcher. Goal: research and gather comprehensive data on the topic."],
    ["human", "Research the topic: {query}. Gather key data and facts."],
  ]);

  const analystPrompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a senior Analyst. Produce balanced, professional analysis."],
    ["human", "Research findings:\n{research}\n\nNow analyze and provide insights on: {query}"],
  ]);

  return {
    async kickoff({ inputs = {} }) {
      const query = String(inputs.query ?? "");
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
      const analysis = await analystPrompt.pipe(llm).pipe(parser).invoke({ query, research });
      return { raw: analysis };
    },
  };
}

async function main() {
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description: _config.description ?? "__AGENT_NAME__ — a CrewAI-style multi-agent system on the Zynd network.",
    version: _config.version ?? "0.1.0",
    category: _config.category ?? "general",
    tags: _config.tags ?? ["crewai", "multi-agent"],
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
  zyndAgent.setCrewAgent(createCrew());

  zyndAgent.onMessage(async (input: HandlerInput, task: TaskHandle) => {
    try {
      return { response: await zyndAgent.invoke(input.message.content) };
    } catch (e) {
      return task.fail(e instanceof Error ? e.message : String(e));
    }
  });

  await zyndAgent.start();

  console.log(`\n__AGENT_NAME__ is running (CrewAI-style)`);
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
