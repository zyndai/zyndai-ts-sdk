import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import { loadKeypair } from "../identity.js";
import { deleteEntity } from "../registry.js";
import { getRegistryUrl, developerKeyPath } from "./config.js";

export function registerDeregisterCommand(program: Command): void {
  program
    .command("deregister")
    .description("Remove an entity from the registry")
    .requiredOption("--entity-id <id>", "Entity ID to deregister")
    .option("--keypair <path>", "Path to the entity's keypair JSON file")
    .action(async (opts: { entityId: string; keypair?: string }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      const keyPath = opts.keypair ?? developerKeyPath();
      if (!fs.existsSync(keyPath)) {
        console.error(chalk.red(`Keypair not found at ${keyPath}`));
        process.exitCode = 1;
        return;
      }

      try {
        const keypair = loadKeypair(keyPath);

        await deleteEntity({
          registryUrl,
          entityId: opts.entityId,
          keypair,
        });

        console.log(chalk.green("Entity deregistered."));
        console.log(`  ${chalk.dim("Entity ID")}  ${opts.entityId}`);
      } catch (err) {
        console.error(chalk.red(`Deregistration failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
