/**
 * Framework registry for `zynd agent init` / `zynd service init`.
 *
 * The TS CLI scaffolds projects in either TypeScript or Python. Each language
 * has its own set of supported frameworks and its own install commands /
 * env keys. The Python set mirrors zyndai-agent/zynd_cli/templates/__init__.py
 * (LangChain, LangGraph, CrewAI, PydanticAI, custom). The TS set adds two
 * TS-native options — Vercel AI SDK and Mastra — on top of ports of the
 * Python frameworks.
 */

export type Language = "ts" | "py";

export interface FrameworkMeta {
  label: string;
  description: string;
  install: string;
  envKeys: string[];
}

// ---- TypeScript frameworks ----
const TS_FRAMEWORKS: Record<string, FrameworkMeta> = {
  langchain: {
    label: "LangChain.js",
    description: "Tool-calling agents with memory and search (LangChain JS port)",
    install: "npm install zyndai @langchain/openai @langchain/community @langchain/core langchain",
    envKeys: ["OPENAI_API_KEY", "TAVILY_API_KEY"],
  },
  langgraph: {
    label: "LangGraph.js",
    description: "Graph-based agent with explicit state management",
    install: "npm install zyndai @langchain/openai @langchain/community @langchain/core @langchain/langgraph",
    envKeys: ["OPENAI_API_KEY", "TAVILY_API_KEY"],
  },
  crewai: {
    label: "CrewAI-style (LangChain.js)",
    description: "Multi-agent collaboration — researcher + analyst pattern. CrewAI has no official TS port, so this template implements the pattern with LangChain.js.",
    install: "npm install zyndai @langchain/openai @langchain/community @langchain/core langchain",
    envKeys: ["OPENAI_API_KEY", "TAVILY_API_KEY"],
  },
  "pydantic-ai": {
    label: "PydanticAI-style (Zod + Vercel AI)",
    description: "Type-safe agents with schema-validated outputs — Zod as the TS analog of Pydantic.",
    install: "npm install zyndai ai @ai-sdk/openai zod",
    envKeys: ["OPENAI_API_KEY"],
  },
  "vercel-ai": {
    label: "Vercel AI SDK",
    description: "Tool-calling, streaming, generateText/Object with any provider",
    install: "npm install zyndai ai @ai-sdk/openai zod",
    envKeys: ["OPENAI_API_KEY"],
  },
  mastra: {
    label: "Mastra",
    description: "Full-stack TypeScript agent framework — agents, tools, workflows, memory",
    install: "npm install zyndai @mastra/core @ai-sdk/openai zod",
    envKeys: ["OPENAI_API_KEY"],
  },
  custom: {
    label: "Custom",
    description: "Minimal template — bring your own framework",
    install: "npm install zyndai",
    envKeys: [],
  },
};

const TS_FRAMEWORK_ORDER = [
  "langchain",
  "langgraph",
  "crewai",
  "pydantic-ai",
  "vercel-ai",
  "mastra",
  "custom",
];

// ---- Python frameworks (mirror zyndai-agent's set) ----
const PY_FRAMEWORKS: Record<string, FrameworkMeta> = {
  langchain: {
    label: "LangChain",
    description: "Tool-calling agents with memory and search",
    install: "pip install zyndai-agent langchain langchain-openai langchain-community langchain-classic",
    envKeys: ["OPENAI_API_KEY", "TAVILY_API_KEY"],
  },
  langgraph: {
    label: "LangGraph",
    description: "Graph-based agent with explicit state management",
    install: "pip install zyndai-agent langchain-openai langchain-community langgraph",
    envKeys: ["OPENAI_API_KEY", "TAVILY_API_KEY"],
  },
  crewai: {
    label: "CrewAI",
    description: "Multi-agent collaboration (researcher + analyst)",
    install: "pip install zyndai-agent crewai crewai-tools",
    envKeys: ["OPENAI_API_KEY", "SERPER_API_KEY"],
  },
  "pydantic-ai": {
    label: "PydanticAI",
    description: "Type-safe agents with structured outputs",
    install: "pip install zyndai-agent pydantic-ai",
    envKeys: ["OPENAI_API_KEY"],
  },
  custom: {
    label: "Custom",
    description: "Minimal template — bring your own framework",
    install: "pip install zyndai-agent",
    envKeys: [],
  },
};

const PY_FRAMEWORK_ORDER = ["langchain", "langgraph", "crewai", "pydantic-ai", "custom"];

export const FRAMEWORKS_BY_LANG: Record<Language, Record<string, FrameworkMeta>> = {
  ts: TS_FRAMEWORKS,
  py: PY_FRAMEWORKS,
};

export const FRAMEWORK_ORDER_BY_LANG: Record<Language, string[]> = {
  ts: TS_FRAMEWORK_ORDER,
  py: PY_FRAMEWORK_ORDER,
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  ts: "TypeScript",
  py: "Python",
};

export const LANGUAGES: Language[] = ["ts", "py"];

/**
 * Resolve a framework key + language to its template file path inside
 * src/templates/ (e.g. ts/langchain.ts.tpl, py/pydantic_ai.py.tpl).
 */
export function templateFileForFramework(lang: Language, framework: string): string {
  const ext = lang === "ts" ? "ts.tpl" : "py.tpl";
  // e.g. "pydantic-ai" -> "pydantic_ai"
  const base = framework.replace(/-/g, "_");
  return `${lang}/${base}.${ext}`;
}

export function serviceTemplateFile(lang: Language): string {
  const ext = lang === "ts" ? "ts.tpl" : "py.tpl";
  return `${lang}/service.${ext}`;
}

export function payloadTemplateFile(lang: Language): string {
  const ext = lang === "ts" ? "ts.tpl" : "py.tpl";
  return `${lang}/payload.${ext}`;
}

/** File extension for the generated entry file (agent/service). */
export function entryExtension(lang: Language): string {
  return lang === "ts" ? "ts" : "py";
}
