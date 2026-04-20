import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Agent project management");

  agent
    .command("init")
    .description("Scaffold a new agent project in the current directory")
    .option("--name <name>", "Agent name")
    .option("--framework <framework>", "Agent framework (custom|langchain|langgraph|vercel_ai)", "custom")
    .action((opts: { name?: string; framework: string }) => {
      const cwd = process.cwd();
      const agentDir = path.join(cwd, ".agent");

      if (fs.existsSync(agentDir)) {
        console.error(chalk.yellow(".agent directory already exists. This is already an agent project."));
        process.exitCode = 1;
        return;
      }

      const name = opts.name ?? path.basename(cwd);

      fs.mkdirSync(agentDir, { recursive: true });

      const agentJson = {
        name,
        framework: opts.framework,
        description: "",
        category: "general",
        tags: [],
        registry_url: "https://registry.zynd.ai",
        webhook_port: 5000,
      };

      fs.writeFileSync(
        path.join(agentDir, "agent.json"),
        JSON.stringify(agentJson, null, 2),
      );

      const entryContent = buildAgentEntry(name, opts.framework);
      const entryFile = path.join(cwd, "agent.ts");
      if (!fs.existsSync(entryFile)) {
        fs.writeFileSync(entryFile, entryContent);
      }

      console.log(chalk.green(`Agent "${name}" scaffolded.`));
      console.log();
      console.log(`  ${chalk.dim("Config")}  .agent/agent.json`);
      console.log(`  ${chalk.dim("Entry")}   agent.ts`);
      console.log();
      console.log(chalk.dim("  Next: edit agent.ts, then run `zynd agent run`"));
    });

  agent
    .command("run")
    .description("Start the agent from the current directory")
    .option("--port <port>", "Override webhook port", parseInt)
    .action(async (opts: { port?: number }) => {
      const configPath = path.join(process.cwd(), ".agent", "agent.json");
      if (!fs.existsSync(configPath)) {
        console.error(chalk.red("No .agent/agent.json found. Run: zynd agent init"));
        process.exitCode = 1;
        return;
      }

      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const name = (raw["name"] as string) ?? "unnamed-agent";
      const port = opts.port ?? (raw["webhook_port"] as number) ?? 5000;

      console.log(chalk.dim(`Starting agent "${name}" on port ${port}...`));
      console.log();

      try {
        const { ZyndAIAgent } = await import("../agent.js");
        const { AgentConfigSchema } = await import("../types.js");
        const config = AgentConfigSchema.parse({
          name,
          description: (raw["description"] as string) ?? "",
          category: (raw["category"] as string) ?? "general",
          tags: (raw["tags"] as string[]) ?? [],
          registryUrl: (raw["registry_url"] as string) ?? "https://registry.zynd.ai",
          webhookPort: port,
          configDir: ".agent",
        });
        const agent = new ZyndAIAgent(config);

        agent.setCustomAgent((input: string) => `Echo: ${input}`);
        await agent.start();
      } catch (err) {
        console.error(chalk.red(`Agent failed to start: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

function buildAgentEntry(name: string, framework: string): string {
  if (framework === "langchain" || framework === "langgraph") {
    return `import { ZyndAIAgent } from "zyndai-agent";

const agent = new ZyndAIAgent({
  name: "${name}",
  description: "TODO: describe your agent",
  category: "general",
  webhookPort: 5000,
  configDir: ".agent",
});

// TODO: set up your ${framework} agent/graph
// agent.setLangchainAgent(executor);
// agent.setLanggraphAgent(graph);

await agent.start();
`;
  }

  if (framework === "vercel_ai") {
    return `import { ZyndAIAgent } from "zyndai-agent";

const agent = new ZyndAIAgent({
  name: "${name}",
  description: "TODO: describe your agent",
  category: "general",
  webhookPort: 5000,
  configDir: ".agent",
});

// TODO: set up your Vercel AI agent
// agent.setVercelAiAgent(model);

await agent.start();
`;
  }

  return `import { ZyndAIAgent } from "zyndai-agent";

const agent = new ZyndAIAgent({
  name: "${name}",
  description: "TODO: describe your agent",
  category: "general",
  webhookPort: 5000,
  configDir: ".agent",
});

agent.setCustomAgent(async (input) => {
  return \`Echo: \${input}\`;
});

await agent.start();
`;
}
