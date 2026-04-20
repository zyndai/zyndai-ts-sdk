import { AgentFramework } from "./types.js";
import { ZyndBase } from "./base.js";
import type { AgentConfig } from "./types.js";

export class ZyndAIAgent extends ZyndBase {
  protected override _entityLabel = "ZYND AI AGENT";
  protected override _entityType = "agent";

  private framework: AgentFramework | null = null;
  private executor: unknown = null;
  private customFn: ((input: string) => string | Promise<string>) | null = null;

  constructor(config: AgentConfig) {
    super(config);
  }

  setLangchainAgent(executor: { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }): void {
    this.executor = executor;
    this.framework = AgentFramework.LANGCHAIN;
  }

  setLanggraphAgent(graph: { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }): void {
    this.executor = graph;
    this.framework = AgentFramework.LANGGRAPH;
  }

  setVercelAiAgent(agent: { generateText: (opts: { prompt: string }) => Promise<{ text: string }> }): void {
    this.executor = agent;
    this.framework = AgentFramework.VERCEL_AI;
  }

  setCustomAgent(fn: (input: string) => string | Promise<string>): void {
    this.customFn = fn;
    this.framework = AgentFramework.CUSTOM;
  }

  async invoke(inputText: string, extra?: Record<string, unknown>): Promise<string> {
    if (!this.framework) {
      throw new Error("No agent framework set. Call one of the set*Agent methods first.");
    }

    switch (this.framework) {
      case AgentFramework.LANGCHAIN: {
        const exec = this.executor as { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
        const result = await exec.invoke({ input: inputText, ...extra });
        return typeof result.output === "string" ? result.output : String(result);
      }

      case AgentFramework.LANGGRAPH: {
        const graph = this.executor as { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
        const result = await graph.invoke({ messages: [["user", inputText]], ...extra });
        const messages = result.messages;
        if (Array.isArray(messages) && messages.length > 0) {
          const last = messages[messages.length - 1] as { content?: string };
          if (typeof last.content === "string") return last.content;
          return String(last);
        }
        return String(result);
      }

      case AgentFramework.VERCEL_AI: {
        const agent = this.executor as { generateText: (opts: { prompt: string }) => Promise<{ text: string }> };
        const result = await agent.generateText({ prompt: inputText });
        return result.text;
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
