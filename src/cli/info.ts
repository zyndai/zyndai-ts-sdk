import type { Command } from "commander";
import chalk from "chalk";
import { getEntity, getEntityCard } from "../registry.js";
import { getRegistryUrl } from "./config.js";

export function registerInfoCommand(program: Command): void {
  program
    .command("info")
    .description("Show detailed entity information")
    .requiredOption("--entity-id <id>", "Entity ID")
    .option("--json", "Output raw JSON")
    .action(async (opts: { entityId: string; json?: boolean }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      try {
        const entity = await getEntity(registryUrl, opts.entityId);

        if (!entity) {
          console.log(chalk.yellow("Entity not found on registry."));
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(entity, null, 2));
          return;
        }

        console.log(chalk.bold(entity["name"] as string));
        console.log();

        const fields: Array<[string, string | undefined]> = [
          ["Entity ID", entity["entity_id"] as string | undefined],
          ["Type", entity["entity_type"] as string | undefined],
          ["Status", entity["status"] as string | undefined],
          ["URL", entity["entity_url"] as string | undefined],
          ["Category", entity["category"] as string | undefined],
          ["Summary", entity["summary"] as string | undefined],
          ["Public key", entity["public_key"] as string | undefined],
          ["Registry", entity["home_registry"] as string | undefined],
          ["Created", entity["created_at"] as string | undefined],
          ["Last beat", entity["last_heartbeat"] as string | undefined],
        ];

        for (const [label, value] of fields) {
          if (value !== undefined && value !== null) {
            const padded = label.padEnd(12);
            console.log(`  ${chalk.dim(padded)} ${value}`);
          }
        }

        const tags = entity["tags"] as string[] | undefined;
        if (tags && tags.length > 0) {
          console.log(`  ${chalk.dim("Tags".padEnd(12))} ${tags.join(", ")}`);
        }

        const card = await getEntityCard(registryUrl, opts.entityId).catch(() => null);
        if (card) {
          console.log();
          console.log(chalk.dim("  Agent card available (use `zynd card show` locally)"));
        }
      } catch (err) {
        console.error(chalk.red(`Info failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
