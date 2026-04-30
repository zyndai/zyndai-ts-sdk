/**
 * `zynd card` — build, show, and validate the A2A AgentCard generated from
 * the project's config.json.
 *
 * The card is auto-generated; users edit `agent.config.json` (or
 * `service.config.json`) and the CLI emits a signed
 * `.well-known/agent-card.json`.
 */

import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { ZyndBaseConfigSchema } from "../types.js";
import {
  resolveKeypair,
  buildRuntimeCard,
  resolveProviderFromDeveloper,
} from "../entity-card-loader.js";
import { generateEntityId } from "../identity.js";
import { buildEntityUrl } from "../config-manager.js";
import { configFromConfigJson } from "./agent.js";

const DEFAULT_CARD_PATH = path.join(".well-known", "agent-card.json");

function readConfig(cwd: string): Record<string, unknown> | null {
  const candidates = [
    path.join(cwd, "agent.config.json"),
    path.join(cwd, "service.config.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    }
  }
  return null;
}

export function registerCardCommand(program: Command): void {
  const card = program
    .command("card")
    .description("A2A AgentCard management (auto-generated from *.config.json)");

  card
    .command("build")
    .description("Generate a signed agent-card.json from this project's config")
    .option("--output <path>", "Output file path", DEFAULT_CARD_PATH)
    .action(async (opts: { output: string }) => {
      const cwd = process.cwd();
      const raw = readConfig(cwd);
      if (!raw) {
        console.error(
          chalk.red(
            "No agent.config.json or service.config.json found in this directory. " +
              "Run `zynd agent init` or `zynd service init` first.",
          ),
        );
        process.exitCode = 1;
        return;
      }

      let config;
      try {
        config = ZyndBaseConfigSchema.parse(configFromConfigJson(raw));
      } catch (err) {
        console.error(
          chalk.red(`Invalid config: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exitCode = 1;
        return;
      }

      let keypair;
      try {
        const argsForKeypair: Parameters<typeof resolveKeypair>[0] = {};
        if (config.keypairPath) argsForKeypair.keypairPath = config.keypairPath;
        if (config.configDir) argsForKeypair.configDir = config.configDir;
        keypair = resolveKeypair(argsForKeypair);
      } catch (err) {
        console.error(
          chalk.red(`Could not resolve keypair: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exitCode = 1;
        return;
      }

      const entityId = generateEntityId(keypair.publicKeyBytes, "agent");
      const baseUrl = buildEntityUrl(config);

      // Auto-resolve provider from the developer keypair + registry. Same
      // logic the SDK runs at agent.start(); doing it here too means the
      // file we write is byte-identical to what would be served live.
      const fallbackProvider = await resolveProviderFromDeveloper({
        registryUrl: config.registryUrl,
      }).catch(() => null);

      const cardJson = buildRuntimeCard({
        config,
        baseUrl,
        keypair,
        entityId,
        ...(fallbackProvider ? { fallbackProvider } : {}),
      });

      const dir = path.dirname(opts.output);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.output, JSON.stringify(cardJson, null, 2));

      console.log(chalk.green("AgentCard generated."));
      console.log(`  ${chalk.dim("File")}     ${opts.output}`);
      console.log(`  ${chalk.dim("Name")}     ${chalk.bold(config.name)}`);
      console.log(`  ${chalk.dim("ID")}       ${chalk.hex("#06B6D4")(entityId)}`);
      console.log(`  ${chalk.dim("URL")}      ${cardJson.url}`);
      console.log(
        `  ${chalk.dim("Skills")}   ${cardJson.skills.map((s: { id: string }) => s.id).join(", ")}`,
      );
    });

  card
    .command("show")
    .description("Display the current agent-card.json")
    .option("--file <path>", "Card file path", DEFAULT_CARD_PATH)
    .action((opts: { file: string }) => {
      if (!fs.existsSync(opts.file)) {
        console.error(chalk.red(`Card file not found: ${opts.file}. Run \`zynd card build\` first.`));
        process.exitCode = 1;
        return;
      }
      const raw = JSON.parse(fs.readFileSync(opts.file, "utf-8")) as Record<string, unknown>;
      const xZynd = (raw["x-zynd"] as Record<string, unknown> | undefined) ?? {};

      console.log(chalk.bold(String(raw["name"])));
      console.log();
      console.log(`  ${chalk.dim("Protocol")}    A2A v${String(raw["protocolVersion"])}`);
      console.log(`  ${chalk.dim("Description")} ${String(raw["description"] ?? "")}`);
      console.log(`  ${chalk.dim("Version")}     ${String(raw["version"])}`);
      console.log(`  ${chalk.dim("URL")}         ${String(raw["url"])}`);
      console.log(
        `  ${chalk.dim("Entity")}      ${chalk.hex("#06B6D4")(String(xZynd["entityId"] ?? "(none)"))}`,
      );
      if (xZynd["fqan"]) console.log(`  ${chalk.dim("FQAN")}        ${String(xZynd["fqan"])}`);
      if (xZynd["pricing"]) {
        console.log(`  ${chalk.dim("Pricing")}     ${JSON.stringify(xZynd["pricing"])}`);
      }
      const skills = (raw["skills"] as Array<{ id: string; name: string }> | undefined) ?? [];
      console.log(
        `  ${chalk.dim("Skills")}      ${skills.map((s) => `${s.id} (${s.name})`).join(", ")}`,
      );
      const capabilities = raw["capabilities"] as Record<string, boolean> | undefined;
      if (capabilities) {
        const enabled = Object.entries(capabilities)
          .filter(([, v]) => v)
          .map(([k]) => k);
        console.log(`  ${chalk.dim("Capabilities")} ${enabled.join(", ") || "(none)"}`);
      }
      const sigs = raw["signatures"] as Array<unknown> | undefined;
      console.log(
        `  ${chalk.dim("Signed")}      ${sigs && sigs.length > 0 ? chalk.green("yes") : chalk.red("no")}`,
      );
    });

  card
    .command("validate")
    .description("Validate that an agent-card.json has the required A2A fields")
    .option("--file <path>", "Card file path", DEFAULT_CARD_PATH)
    .action((opts: { file: string }) => {
      if (!fs.existsSync(opts.file)) {
        console.error(chalk.red(`Card file not found: ${opts.file}`));
        process.exitCode = 1;
        return;
      }
      const raw = JSON.parse(fs.readFileSync(opts.file, "utf-8")) as Record<string, unknown>;
      const issues: string[] = [];
      const required = [
        "protocolVersion",
        "name",
        "description",
        "version",
        "url",
        "capabilities",
        "defaultInputModes",
        "defaultOutputModes",
        "skills",
      ];
      for (const k of required) {
        if (raw[k] === undefined || raw[k] === null) issues.push(`missing required field: ${k}`);
      }
      const skills = raw["skills"];
      if (Array.isArray(skills) && skills.length === 0) issues.push("skills array is empty");

      if (issues.length > 0) {
        console.log(chalk.red("Card validation failed:"));
        for (const i of issues) console.log(`  ${chalk.red("•")} ${i}`);
        process.exitCode = 1;
      } else {
        console.log(chalk.green("Card is valid."));
      }
    });
}
