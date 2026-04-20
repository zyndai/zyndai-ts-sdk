import type { Command } from "commander";
import chalk from "chalk";
import { getEntity } from "../registry.js";
import { getRegistryUrl } from "./config.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Check entity status on the registry")
    .requiredOption("--entity-id <id>", "Entity ID")
    .action(async (opts: { entityId: string }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      try {
        const entity = await getEntity(registryUrl, opts.entityId);

        if (!entity) {
          console.log(chalk.yellow("Entity not found on registry."));
          process.exitCode = 1;
          return;
        }

        const status = entity["status"] as string | undefined;
        const statusColor = status === "active" ? chalk.green : chalk.yellow;

        console.log(chalk.bold(entity["name"] as string));
        console.log();
        console.log(`  ${chalk.dim("Entity ID")}    ${chalk.hex("#06B6D4")(opts.entityId)}`);
        console.log(`  ${chalk.dim("Status")}       ${statusColor(status ?? "unknown")}`);

        if (entity["entity_url"]) {
          console.log(`  ${chalk.dim("URL")}          ${entity["entity_url"]}`);
        }
        if (entity["last_heartbeat"]) {
          console.log(`  ${chalk.dim("Last beat")}    ${entity["last_heartbeat"]}`);
        }
      } catch (err) {
        console.error(chalk.red(`Status check failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
