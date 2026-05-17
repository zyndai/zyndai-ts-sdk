import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import { loadKeypair, generateDeveloperId } from "../identity.js";
import { getDeveloper, registerName } from "../registry.js";
import { getRegistryUrl, developerKeyPath } from "./config.js";

export function registerNameCommand(program: Command): void {
  const nameCmd = program
    .command("name")
    .description("ZNS name management");

  nameCmd
    .command("bind")
    .description("Bind a FQAN to an existing entity")
    .requiredOption("--entity-id <id>", "Entity ID (e.g. zns:abc123...)")
    .requiredOption("--entity-name <name>", "Name slug to register under your handle (e.g. my-agent)")
    .option("--handle <handle>", "Developer handle override (auto-fetched from registry if omitted)")
    .option("--version <version>", "Version string (default: 1.0.0)")
    .option("--tags <tags>", "Comma-separated capability tags", commaSplit)
    .action(async (opts: {
      entityId: string;
      entityName: string;
      handle?: string;
      version?: string;
      tags?: string[];
    }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);
      const devPath = developerKeyPath();

      if (!fs.existsSync(devPath)) {
        console.error(chalk.red("No developer keypair found. Run 'zynd auth login --registry <url>' first."));
        process.exitCode = 1;
        return;
      }

      const devKp = loadKeypair(devPath);
      let handle = opts.handle;

      if (!handle) {
        const devId = generateDeveloperId(devKp.publicKeyBytes);
        try {
          const dev = await getDeveloper(registryUrl, devId);
          if (!dev || !dev["dev_handle"]) {
            console.error(chalk.red(
              "Could not resolve your developer handle from registry.\n" +
              "Claim a handle first or pass --handle explicitly."
            ));
            process.exitCode = 1;
            return;
          }
          handle = dev["dev_handle"] as string;
        } catch (err) {
          console.error(chalk.red(`Failed to fetch developer info: ${err instanceof Error ? err.message : String(err)}`));
          process.exitCode = 1;
          return;
        }
      }

      try {
        const fqan = await registerName({
          registryUrl,
          developerKeypair: devKp,
          developerHandle: handle,
          entityId: opts.entityId,
          entityName: opts.entityName,
          version: opts.version ?? "1.0.0",
          capabilityTags: opts.tags,
        });
        console.log(chalk.green("Name bound successfully!"));
        console.log(`  FQAN:       ${fqan}`);
        console.log(`  Entity ID:  ${opts.entityId}`);
        console.log(`  Handle:     ${handle}`);
        console.log(`  Registry:   ${registryUrl}`);
      } catch (err) {
        console.error(chalk.red(`Failed to bind name: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

function commaSplit(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}
