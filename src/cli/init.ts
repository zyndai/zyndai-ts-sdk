import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import { generateKeypair, generateDeveloperId, saveKeypair } from "../identity.js";
import {
  ensureZyndDir,
  developerKeyPath,
  saveCliConfig,
  getRegistryUrl,
} from "./config.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize developer identity (Ed25519 keypair)")
    .option("--force", "Overwrite existing developer key")
    .action((opts: { force?: boolean }) => {
      const keyPath = developerKeyPath();

      if (fs.existsSync(keyPath) && !opts.force) {
        console.error(chalk.yellow("Developer key already exists at"), keyPath);
        console.error(chalk.dim("Use --force to overwrite."));
        process.exitCode = 1;
        return;
      }

      ensureZyndDir();
      const kp = generateKeypair();
      saveKeypair(kp, keyPath);

      // Persist default registry URL so subsequent commands have a config baseline.
      saveCliConfig({ registry_url: getRegistryUrl() });

      const devId = generateDeveloperId(kp.publicKeyBytes);

      console.log(chalk.green("Developer identity created."));
      console.log();
      console.log(`  ${chalk.dim("Key file")}      ${keyPath}`);
      console.log(`  ${chalk.dim("Developer ID")}  ${chalk.hex("#06B6D4")(devId)}`);
      console.log(`  ${chalk.dim("Public key")}    ${chalk.dim(kp.publicKeyString)}`);
    });
}
