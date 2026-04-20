import type { Command } from "commander";
import chalk from "chalk";
import { searchEntities } from "../registry.js";
import { getRegistryUrl } from "./config.js";

export function registerResolveCommand(program: Command): void {
  program
    .command("resolve")
    .description("Resolve an FQAN to an entity")
    .argument("<fqan>", "Fully-qualified agent name (e.g. @dev/agent-name)")
    .option("--json", "Output raw JSON")
    .action(async (fqan: string, opts: { json?: boolean }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      try {
        const result = await searchEntities({
          registryUrl,
          query: { fqan, max_results: 1 },
        });

        if (result.results.length === 0) {
          console.log(chalk.yellow(`No entity found for FQAN: ${fqan}`));
          process.exitCode = 1;
          return;
        }

        const entity = result.results[0];

        if (opts.json) {
          console.log(JSON.stringify(entity, null, 2));
          return;
        }

        console.log(chalk.bold(entity.name));
        console.log();
        console.log(`  ${chalk.dim("FQAN")}       ${fqan}`);
        console.log(`  ${chalk.dim("Entity ID")}  ${chalk.hex("#06B6D4")(entity.entity_id)}`);
        console.log(`  ${chalk.dim("URL")}        ${entity.entity_url}`);
        if (entity.summary) {
          console.log(`  ${chalk.dim("Summary")}    ${entity.summary}`);
        }
      } catch (err) {
        console.error(chalk.red(`Resolve failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
