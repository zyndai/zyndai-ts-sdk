import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEntityCard } from "../entity-card-loader.js";
import { buildEntityCard, signEntityCard } from "../entity-card.js";
import { generateKeypair, generateEntityId, loadKeypair } from "../identity.js";
import type { EntityCard } from "../types.js";

const DEFAULT_CARD_PATH = path.join(".well-known", "agent.json");

export function registerCardCommand(program: Command): void {
  const card = program
    .command("card")
    .description("Agent card management");

  card
    .command("init")
    .description("Create a new agent card file")
    .option("--name <name>", "Entity name")
    .option("--description <desc>", "Entity description")
    .option("--url <url>", "Entity base URL")
    .option("--keypair <path>", "Path to keypair file")
    .option("--output <path>", "Output file path", DEFAULT_CARD_PATH)
    .option("--price <price>", "Per-call price (e.g. $0.01)")
    .action((opts: {
      name?: string;
      description?: string;
      url?: string;
      keypair?: string;
      output: string;
      price?: string;
    }) => {
      const name = opts.name ?? "my-agent";
      const description = opts.description ?? "";
      const entityUrl = opts.url ?? "http://localhost:5000";

      let keypair;
      if (opts.keypair && fs.existsSync(opts.keypair)) {
        keypair = loadKeypair(opts.keypair);
      } else {
        keypair = generateKeypair();
      }

      const entityId = generateEntityId(keypair.publicKeyBytes);

      const unsigned = buildEntityCard({
        entityId,
        name,
        description,
        entityUrl,
        keypair,
        price: opts.price,
      });
      const signed = signEntityCard(unsigned, keypair);

      const dir = path.dirname(opts.output);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.output, JSON.stringify(signed, null, 2));

      console.log(chalk.green("Agent card created."));
      console.log(`  ${chalk.dim("File")}  ${opts.output}`);
      console.log(`  ${chalk.dim("ID")}    ${chalk.hex("#06B6D4")(entityId)}`);
    });

  card
    .command("show")
    .description("Display agent card from file")
    .option("--file <path>", "Card file path", DEFAULT_CARD_PATH)
    .action((opts: { file: string }) => {
      if (!fs.existsSync(opts.file)) {
        console.error(chalk.red(`Card file not found: ${opts.file}`));
        process.exitCode = 1;
        return;
      }

      const raw = JSON.parse(fs.readFileSync(opts.file, "utf-8")) as EntityCard;

      console.log(chalk.bold(raw.name));
      console.log();
      console.log(`  ${chalk.dim("Entity ID")}    ${chalk.hex("#06B6D4")(raw.entity_id)}`);
      console.log(`  ${chalk.dim("Description")}  ${raw.description}`);
      console.log(`  ${chalk.dim("Version")}      ${raw.version}`);
      console.log(`  ${chalk.dim("Status")}       ${raw.status}`);
      console.log(`  ${chalk.dim("URL")}          ${raw.entity_url}`);
      console.log(`  ${chalk.dim("Public key")}   ${chalk.dim(raw.public_key)}`);

      if (raw.capabilities && raw.capabilities.length > 0) {
        const caps = raw.capabilities.map((c) => c.name).join(", ");
        console.log(`  ${chalk.dim("Capabilities")} ${caps}`);
      }

      if (raw.pricing) {
        console.log(`  ${chalk.dim("Pricing")}      ${raw.pricing.currency} ${JSON.stringify(raw.pricing.rates)}`);
      }

      if (raw.signature) {
        console.log(`  ${chalk.dim("Signed")}       ${chalk.green("yes")}`);
      }
    });

  card
    .command("validate")
    .description("Validate an agent card file")
    .option("--file <path>", "Card file path", DEFAULT_CARD_PATH)
    .action((opts: { file: string }) => {
      try {
        const staticCard = loadEntityCard(opts.file);

        const issues: string[] = [];
        if (!staticCard.name) issues.push("missing name");
        if (!staticCard.description) issues.push("missing description");

        if (issues.length > 0) {
          console.log(chalk.yellow(`Card valid with warnings: ${issues.join(", ")}`));
        } else {
          console.log(chalk.green("Card is valid."));
        }

        console.log(`  ${chalk.dim("Name")}  ${staticCard.name}`);
        if (staticCard.version) {
          console.log(`  ${chalk.dim("Version")}  ${staticCard.version}`);
        }
      } catch (err) {
        console.error(chalk.red(`Validation failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
