import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerServiceCommand(program: Command): void {
  const service = program
    .command("service")
    .description("Service project management");

  service
    .command("init")
    .description("Scaffold a new service project in the current directory")
    .option("--name <name>", "Service name")
    .action((opts: { name?: string }) => {
      const cwd = process.cwd();
      const serviceDir = path.join(cwd, ".service");

      if (fs.existsSync(serviceDir)) {
        console.error(chalk.yellow(".service directory already exists. This is already a service project."));
        process.exitCode = 1;
        return;
      }

      const name = opts.name ?? path.basename(cwd);

      fs.mkdirSync(serviceDir, { recursive: true });

      const serviceJson = {
        name,
        description: "",
        category: "general",
        tags: [],
        registry_url: "https://registry.zynd.ai",
        webhook_port: 5000,
      };

      fs.writeFileSync(
        path.join(serviceDir, "service.json"),
        JSON.stringify(serviceJson, null, 2),
      );

      const entryFile = path.join(cwd, "service.ts");
      if (!fs.existsSync(entryFile)) {
        fs.writeFileSync(entryFile, buildServiceEntry(name));
      }

      console.log(chalk.green(`Service "${name}" scaffolded.`));
      console.log();
      console.log(`  ${chalk.dim("Config")}  .service/service.json`);
      console.log(`  ${chalk.dim("Entry")}   service.ts`);
      console.log();
      console.log(chalk.dim("  Next: edit service.ts, then run `zynd service run`"));
    });

  service
    .command("run")
    .description("Start the service from the current directory")
    .option("--port <port>", "Override webhook port", parseInt)
    .action(async (opts: { port?: number }) => {
      const configPath = path.join(process.cwd(), ".service", "service.json");
      if (!fs.existsSync(configPath)) {
        console.error(chalk.red("No .service/service.json found. Run: zynd service init"));
        process.exitCode = 1;
        return;
      }

      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const name = (raw["name"] as string) ?? "unnamed-service";
      const port = opts.port ?? (raw["webhook_port"] as number) ?? 5000;

      console.log(chalk.dim(`Starting service "${name}" on port ${port}...`));
      console.log();

      try {
        const { ZyndService } = await import("../service.js");
        const { ServiceConfigSchema } = await import("../types.js");
        const config = ServiceConfigSchema.parse({
          name,
          description: (raw["description"] as string) ?? "",
          category: (raw["category"] as string) ?? "general",
          tags: (raw["tags"] as string[]) ?? [],
          registryUrl: (raw["registry_url"] as string) ?? "https://registry.zynd.ai",
          webhookPort: port,
          configDir: ".service",
        });
        const svc = new ZyndService(config);

        svc.setHandler((input: string) => `Service echo: ${input}`);
        await svc.start();
      } catch (err) {
        console.error(chalk.red(`Service failed to start: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

function buildServiceEntry(name: string): string {
  return `import { ZyndService } from "zyndai-agent";

const service = new ZyndService({
  name: "${name}",
  description: "TODO: describe your service",
  category: "general",
  webhookPort: 5000,
  configDir: ".service",
});

service.setHandler(async (input) => {
  return \`Service response: \${input}\`;
});

await service.start();
`;
}
