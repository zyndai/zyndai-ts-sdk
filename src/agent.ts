import { AgentFramework } from "./types.js";
import { ZyndBase } from "./base.js";
import type { ValidationOptions, Handler, HandlerInput, TaskHandle } from "./base.js";
import type { AgentConfig } from "./types.js";

// ---- Duck-typed framework shapes ----
//
// Users bring their own framework libraries; we only need the minimum
// invoke surface area each one exposes. These interfaces keep the framework
// dependencies optional at compile time.

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
  run(input: string, extra?: Record<string, unknown>): Promise<{ data?: unknown }>;
}
export interface VercelAiLike {
  generateText(opts: { prompt: string }): Promise<{ text: string }>;
}
export interface MastraLike {
  generate(
    input: string | Array<{ role: string; content: string }>,
    opts?: Record<string, unknown>,
  ): Promise<{ text?: string; object?: unknown }>;
}

/**
 * ZyndAIAgent — multi-framework agent on the Zynd network.
 *
 * Two ways to wire up logic:
 *   1. Framework setter (set*Agent) + invoke()  — quick path. The default
 *      handler converts the inbound message's text content into a string,
 *      runs the framework, and returns the result.
 *   2. onMessage(handler) — full control. Receives the parsed
 *      HandlerInput + a TaskHandle for streaming updates, asking for input,
 *      emitting artifacts, or completing the task explicitly.
 */
export class ZyndAIAgent extends ZyndBase {
  private framework: AgentFramework | null = null;
  private executor: unknown = null;
  private customFn: ((input: string) => string | Promise<string>) | null = null;
  private userHandler: Handler | null = null;

  constructor(config: AgentConfig, validation?: ValidationOptions) {
    super(config, validation, "agent", "ZYND AI AGENT");
    // Default handler: dispatch to whichever framework was wired up.
    this.installHandler(this.defaultHandler.bind(this));
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

  // ---- Custom handler ----

  /**
   * Override the default framework dispatch with full control over the
   * inbound message and the Task lifecycle.
   *
   * Example:
   *   agent.onMessage(async (input, task) => {
   *     if (!input.payload.target_language) {
   *       return task.ask("Which language should I translate to?");
   *     }
   *     await task.update("working", { text: "Translating..." });
   *     const result = await translate(input.payload);
   *     return task.complete({ data: result });
   *   });
   */
  onMessage(handler: Handler): void {
    this.userHandler = handler;
    this.installHandler(handler);
  }

  // ---- Universal invoke (used by default handler) ----

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

  // ---------------------------------------------------------------------------
  // Default handler — runs when no onMessage() override is registered
  // ---------------------------------------------------------------------------

  private async defaultHandler(input: HandlerInput, task: TaskHandle): Promise<unknown> {
    // If a custom user handler is set, this method should never be called
    // (setHandler in onMessage replaces this binding). Belt-and-suspenders:
    if (this.userHandler) {
      return this.userHandler(input, task);
    }

    if (!this.framework) {
      return task.fail(
        "Agent has no framework registered. Call set*Agent or use onMessage to override.",
      );
    }
    try {
      const text = await this.invoke(input.message.content);
      return { text };
    } catch (err) {
      return task.fail(err instanceof Error ? err.message : String(err));
    }
  }
}
