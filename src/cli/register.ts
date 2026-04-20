import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateKeypair,
  loadKeypair,
  deriveAgentKeypair,
  createDerivationProof,
  generateDeveloperId,
} from "../identity.js";
import { registerEntity } from "../registry.js";
import { getRegistryUrl, agentsDir, developerKeyPath } from "./config.js";

export function registerRegisterCommand(program: Command): void {
  program
    .command("register")
    .description("Register an entity on the ZyndAI registry")
    .requiredOption("--name <name>", "Entity name")
    .requiredOption("--agent-url <url>", "Public URL for the entity")
    .option("--category <category>", "Category", "general")
    .option("--tags <tags>", "Comma-separated tags", commaSplit)
    .option("--summary <text>", "Short description")
    .option("--keypair <path>", "Path to keypair JSON file")
    .option("--index <n>", "Derive from developer key at this index", parseInt)
    .option("--type <type>", "Entity type (agent|service)", "agent")
    .action(async (opts: {
      name: string;
      agentUrl: string;
      category: string;
      tags?: string[];
      summary?: string;
      keypair?: string;
      index?: number;
      type: string;
    }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      let keypair;
      let developerId: string | undefined;
      let developerProof: Record<string, unknown> | undefined;

      try {
        if (opts.index !== undefined && !isNaN(opts.index)) {
          const devPath = opts.keypair ?? developerKeyPath();
          if (!fs.existsSync(devPath)) {
            console.error(chalk.red("Developer key not found. Run: zynd init"));
            process.exitCode = 1;
            return;
          }
          const devKp = loadKeypair(devPath);
          keypair = deriveAgentKeypair(devKp.privateKeyBytes, opts.index);
          const proof = createDerivationProof(devKp, keypair.publicKeyBytes, opts.index);
          developerId = generateDeveloperId(devKp.publicKeyBytes);
          developerProof = proof;
        } else if (opts.keypair) {
          keypair = loadKeypair(opts.keypair);
        } else {
          const dir = agentsDir();
          const namePath = path.join(dir, `${opts.name}.json`);
          if (fs.existsSync(namePath)) {
            keypair = loadKeypair(namePath);
          } else {
            keypair = generateKeypair();
          }
        }

        const entityId = await registerEntity({
          registryUrl,
          keypair,
          name: opts.name,
          entityUrl: opts.agentUrl,
          category: opts.category,
          tags: opts.tags,
          summary: opts.summary,
          developerId,
          developerProof,
          entityType: opts.type,
        });

        console.log(chalk.green("Entity registered."));
        console.log();
        console.log(`  ${chalk.dim("Entity ID")}  ${chalk.hex("#06B6D4")(entityId)}`);
        console.log(`  ${chalk.dim("Name")}       ${opts.name}`);
        console.log(`  ${chalk.dim("URL")}        ${opts.agentUrl}`);
        console.log(`  ${chalk.dim("Registry")}   ${registryUrl}`);
      } catch (err) {
        console.error(chalk.red(`Registration failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

function commaSplit(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}
