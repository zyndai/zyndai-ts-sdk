import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateKeypair,
  generateDeveloperId,
  generateEntityId,
  loadKeypair,
  saveKeypair,
  deriveAgentKeypair,
  createDerivationProof,
} from "../identity.js";
import { ensureZyndDir, developerKeyPath, agentsDir } from "./config.js";

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage Ed25519 keypairs");

  keys
    .command("list")
    .description("List developer key and agent keypairs")
    .action(() => {
      const devPath = developerKeyPath();
      if (fs.existsSync(devPath)) {
        const kp = loadKeypair(devPath);
        const devId = generateDeveloperId(kp.publicKeyBytes);
        console.log(chalk.bold("Developer key"));
        console.log(`  ${chalk.dim("File")}    ${devPath}`);
        console.log(`  ${chalk.dim("ID")}      ${chalk.hex("#06B6D4")(devId)}`);
        console.log(`  ${chalk.dim("Public")}  ${chalk.dim(kp.publicKeyString)}`);
      } else {
        console.log(chalk.dim("No developer key. Run: zynd init"));
      }

      const agentDir = agentsDir();
      if (fs.existsSync(agentDir)) {
        const files = fs.readdirSync(agentDir).filter((f) => f.endsWith(".json"));
        if (files.length > 0) {
          console.log();
          console.log(chalk.bold("Agent keys"));
          for (const file of files) {
            const kp = loadKeypair(path.join(agentDir, file));
            const entityId = generateEntityId(kp.publicKeyBytes);
            const name = path.basename(file, ".json");
            console.log(`  ${chalk.white(name)} ${chalk.dim("→")} ${chalk.hex("#06B6D4")(entityId)}`);
          }
        }
      }
    });

  keys
    .command("create")
    .description("Generate a standalone keypair")
    .requiredOption("--name <name>", "Keypair name")
    .action((opts: { name: string }) => {
      const dir = agentsDir();
      fs.mkdirSync(dir, { recursive: true });

      const filePath = path.join(dir, `${opts.name}.json`);
      if (fs.existsSync(filePath)) {
        console.error(chalk.yellow(`Keypair "${opts.name}" already exists at`), filePath);
        process.exitCode = 1;
        return;
      }

      const kp = generateKeypair();
      saveKeypair(kp, filePath);

      const entityId = generateEntityId(kp.publicKeyBytes);
      console.log(chalk.green(`Keypair "${opts.name}" created.`));
      console.log(`  ${chalk.dim("File")}       ${filePath}`);
      console.log(`  ${chalk.dim("Entity ID")}  ${chalk.hex("#06B6D4")(entityId)}`);
      console.log(`  ${chalk.dim("Public")}     ${chalk.dim(kp.publicKeyString)}`);
    });

  keys
    .command("derive")
    .description("Derive agent keypair from developer key via HD derivation")
    .requiredOption("--index <n>", "Derivation index", parseInt)
    .option("--name <name>", "Save with this name (default: agent-<index>)")
    .action((opts: { index: number; name?: string }) => {
      const devPath = developerKeyPath();
      if (!fs.existsSync(devPath)) {
        console.error(chalk.red("No developer key found. Run: zynd init"));
        process.exitCode = 1;
        return;
      }

      if (isNaN(opts.index) || opts.index < 0) {
        console.error(chalk.red("Index must be a non-negative integer."));
        process.exitCode = 1;
        return;
      }

      const devKp = loadKeypair(devPath);
      const derived = deriveAgentKeypair(devKp.privateKeyBytes, opts.index);
      const proof = createDerivationProof(devKp, derived.publicKeyBytes, opts.index);

      const name = opts.name ?? `agent-${opts.index}`;
      const dir = agentsDir();
      fs.mkdirSync(dir, { recursive: true });

      const filePath = path.join(dir, `${name}.json`);
      saveKeypair(derived, filePath, {
        developer_public_key: proof.developer_public_key,
        entity_index: proof.entity_index,
        developer_signature: proof.developer_signature,
      });

      const entityId = generateEntityId(derived.publicKeyBytes);
      console.log(chalk.green(`Derived keypair "${name}" (index ${opts.index}).`));
      console.log(`  ${chalk.dim("File")}       ${filePath}`);
      console.log(`  ${chalk.dim("Entity ID")}  ${chalk.hex("#06B6D4")(entityId)}`);
      console.log(`  ${chalk.dim("Public")}     ${chalk.dim(derived.publicKeyString)}`);
    });

  keys
    .command("show")
    .description("Display keypair details")
    .argument("<name>", "Keypair name (file in ~/.zynd/agents/)")
    .action((name: string) => {
      const filePath = path.join(agentsDir(), `${name}.json`);
      if (!fs.existsSync(filePath)) {
        const devPath = developerKeyPath();
        if (name === "developer" && fs.existsSync(devPath)) {
          showKeypairDetails("developer", devPath, true);
          return;
        }
        console.error(chalk.red(`Keypair "${name}" not found at ${filePath}`));
        process.exitCode = 1;
        return;
      }

      showKeypairDetails(name, filePath, false);
    });
}

function showKeypairDetails(name: string, filePath: string, isDeveloper: boolean): void {
  const kp = loadKeypair(filePath);
  const id = isDeveloper
    ? generateDeveloperId(kp.publicKeyBytes)
    : generateEntityId(kp.publicKeyBytes);

  console.log(chalk.bold(name));
  console.log(`  ${chalk.dim("File")}        ${filePath}`);
  console.log(`  ${chalk.dim("ID")}          ${chalk.hex("#06B6D4")(id)}`);
  console.log(`  ${chalk.dim("Public key")}  ${chalk.dim(kp.publicKeyString)}`);
  console.log(`  ${chalk.dim("Private")}     ${chalk.dim(kp.privateKeyB64.slice(0, 8) + "...")}`);

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  if (raw["derived_from"]) {
    const meta = raw["derived_from"] as Record<string, unknown>;
    console.log(`  ${chalk.dim("Derived")}     index=${meta["entity_index"]}`);
  }
}
