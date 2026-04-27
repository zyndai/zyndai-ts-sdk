import { AgentFramework } from "./types.js";
import { ZyndBase } from "./base.js";
import type { ValidationOptions } from "./base.js";
import type { AgentConfig } from "./types.js";

// ---- Duck-typed framework shapes ----
//
// We deliberately avoid importing the framework libraries here — users bring
// their own LangChain/LangGraph/Mastra/etc. The setters just describe the
// minimum surface area the dispatcher needs so TypeScript can type-check the
// call site without forcing a runtime dependency.

export interface LangchainExecutor {
  invoke(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface LanggraphGraph {
  invoke(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CrewLike {
  kickoff(args: { inputs?: Record<string, unknown> }):
    | { raw?: string }
    | string
    | Promise<{ raw?: string } | string>;
}

export interface PydanticAiLike {
  // Mirrors PydanticAI's Python `run` / `run_sync` surface — async here.
  run(input: string, extra?: Record<string, unknown>): Promise<{ data?: unknown }>;
}

export interface VercelAiLike {
  generateText(opts: { prompt: string }): Promise<{ text: string }>;
}

export interface MastraLike {
  // Mastra agents expose `.generate(input, opts?)` that resolves to { text }.
  generate(
    input: string | Array<{ role: string; content: string }>,
    opts?: Record<string, unknown>,
  ): Promise<{ text?: string; object?: unknown }>;
}

export class ZyndAIAgent extends ZyndBase {
  protected override _entityLabel = "ZYND AI AGENT";
  protected override _entityType = "agent";

  private framework: AgentFramework | null = null;
  private executor: unknown = null;
  private customFn: ((input: string) => string | Promise<string>) | null = null;

  constructor(config: AgentConfig, validation?: ValidationOptions) {
    super(config, validation);
  }

  // ---- Framework setters ----

  setLangchainAgent(executor: LangchainExecutor): void {
    this.executor = executor;
    this.framework = AgentFramework.LANGCHAIN;
  }

  setLanggraphAgent(graph: LanggraphGraph): void {
    this.executor = graph;
    this.framework = AgentFramework.LANGGRAPH;
  }

  setCrewAgent(crew: CrewLike): void {
    this.executor = crew;
    this.framework = AgentFramework.CREWAI;
  }

  setPydanticAiAgent(agent: PydanticAiLike): void {
    this.executor = agent;
    this.framework = AgentFramework.PYDANTIC_AI;
  }

  setVercelAiAgent(agent: VercelAiLike): void {
    this.executor = agent;
    this.framework = AgentFramework.VERCEL_AI;
  }

  setMastraAgent(agent: MastraLike): void {
    this.executor = agent;
    this.framework = AgentFramework.MASTRA;
  }

  setCustomAgent(fn: (input: string) => string | Promise<string>): void {
    this.customFn = fn;
    this.framework = AgentFramework.CUSTOM;
  }

  // ---- Universal invoke ----

  async invoke(inputText: string, extra?: Record<string, unknown>): Promise<string> {
    if (!this.framework) {
      throw new Error("No agent framework set. Call one of the set*Agent methods first.");
    }

    switch (this.framework) {
      case AgentFramework.LANGCHAIN: {
        const exec = this.executor as LangchainExecutor;
        const result = await exec.invoke({ input: inputText, ...extra });
        return typeof result.output === "string" ? result.output : String(result);
      }

      case AgentFramework.LANGGRAPH: {
        const graph = this.executor as LanggraphGraph;
        const result = await graph.invoke({ messages: [["user", inputText]], ...extra });
        const messages = result.messages;
        if (Array.isArray(messages) && messages.length > 0) {
          const last = messages[messages.length - 1] as { content?: string };
          if (typeof last.content === "string") return last.content;
          return String(last);
        }
        return String(result);
      }

      case AgentFramework.CREWAI: {
        const crew = this.executor as CrewLike;
        const result = await crew.kickoff({ inputs: { query: inputText, ...extra } });
        if (typeof result === "string") return result;
        if (result && typeof result === "object" && "raw" in result && typeof result.raw === "string") {
          return result.raw;
        }
        return String(result);
      }

      case AgentFramework.PYDANTIC_AI: {
        const agent = this.executor as PydanticAiLike;
        const result = await agent.run(inputText, extra);
        if (result && "data" in result && result.data !== undefined) {
          return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
        }
        return String(result);
      }

      case AgentFramework.VERCEL_AI: {
        const agent = this.executor as VercelAiLike;
        const result = await agent.generateText({ prompt: inputText });
        return result.text;
      }

      case AgentFramework.MASTRA: {
        const agent = this.executor as MastraLike;
        const result = await agent.generate(inputText, extra);
        if (typeof result.text === "string") return result.text;
        if (result.object !== undefined) return JSON.stringify(result.object);
        return String(result);
      }

      case AgentFramework.CUSTOM: {
        if (!this.customFn) {
          throw new Error("Custom agent invoke function not set.");
        }
        return this.customFn(inputText);
      }

      default:
        throw new Error(`Unknown agent framework: ${String(this.framework)}`);
    }
  }
}
