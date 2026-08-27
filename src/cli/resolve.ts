import type { Command } from "commander";
import chalk from "chalk";
import { resolveName } from "../registry.js";
import { getRegistryUrl } from "./config.js";

// Parse an FQAN into developer handle + entity name.
// Accepts "@handle/name", "handle/name", or "host/handle/name" (host dropped).
function parseFqan(input: string): { developer: string; entity: string } | null {
  let s = input.trim();
  if (s.startsWith("@")) s = s.slice(1);
  s = s.replace(/^https?:\/\//, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length === 2) return { developer: parts[0], entity: parts[1] };
  if (parts.length === 3) return { developer: parts[1], entity: parts[2] };
  return null;
}

export function registerResolveCommand(program: Command): void {
  program
    .command("resolve")
    .description("Resolve an FQAN to an entity")
    .argument("<fqan>", "Fully-qualified agent name (e.g. @dev/agent-name)")
    .option("--json", "Output raw JSON")
    .action(async (fqan: string, opts: { json?: boolean }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      const parsed = parseFqan(fqan);
      if (!parsed) {
        console.error(chalk.red(`Invalid FQAN: ${fqan}. Expected @handle/name or host/handle/name.`));
        process.exitCode = 1;
        return;
      }

      try {
        const entity = await resolveName(registryUrl, parsed.developer, parsed.entity);

        if (opts.json) {
          console.log(JSON.stringify(entity, null, 2));
          return;
        }

        console.log(chalk.bold(parsed.entity));
        console.log();
        console.log(`  ${chalk.dim("FQAN")}       ${entity.fqan}`);
        console.log(`  ${chalk.dim("Entity ID")}  ${chalk.hex("#06B6D4")(entity.entity_id)}`);
        console.log(`  ${chalk.dim("URL")}        ${entity.entity_url ?? "(not set)"}`);
        console.log(`  ${chalk.dim("Status")}    ${entity.status ?? "unknown"}`);
        if (entity.trust_score !== undefined) {
          console.log(`  ${chalk.dim("Trust")}     ${entity.trust_score}`);
        }
      } catch (err) {
        console.error(chalk.red(`Resolve failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
