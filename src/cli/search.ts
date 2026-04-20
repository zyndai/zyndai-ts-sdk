import type { Command } from "commander";
import chalk from "chalk";
import { searchEntities } from "../registry.js";
import { getRegistryUrl } from "./config.js";
import type { AgentSearchResponse, SearchRequest } from "../types.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Search for agents and services on the registry")
    .option("-q, --query <text>", "Free-text search query")
    .option("--category <category>", "Filter by category")
    .option("--tags <tags>", "Comma-separated tags", commaSplit)
    .option("--skills <skills>", "Comma-separated skills", commaSplit)
    .option("--type <type>", "Entity type (agent|service)")
    .option("--status <status>", "Filter by status")
    .option("--max-results <n>", "Max results", parseInt)
    .option("--federated", "Federated cross-registry search")
    .option("--enrich", "Include full agent cards in results")
    .option("--json", "Output raw JSON")
    .action(async (opts: {
      query?: string;
      category?: string;
      tags?: string[];
      skills?: string[];
      type?: string;
      status?: string;
      maxResults?: number;
      federated?: boolean;
      enrich?: boolean;
      json?: boolean;
    }) => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      const query: SearchRequest = {};
      if (opts.query) query.query = opts.query;
      if (opts.category) query.category = opts.category;
      if (opts.tags) query.tags = opts.tags;
      if (opts.skills) query.skills = opts.skills;
      if (opts.type) query.entity_type = opts.type;
      if (opts.status) query.status = opts.status;
      if (opts.maxResults) query.max_results = opts.maxResults;
      if (opts.federated) query.federated = true;
      if (opts.enrich) query.enrich = true;

      try {
        const result = await searchEntities({ registryUrl, query });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.results.length === 0) {
          console.log(chalk.dim("No results found."));
          return;
        }

        console.log(chalk.bold(`Found ${result.total_found} entities`));
        console.log();

        for (const entity of result.results) {
          printEntity(entity);
        }

        if (result.has_more) {
          console.log(chalk.dim(`  ... and more. Showing ${result.results.length} of ${result.total_found}.`));
        }
      } catch (err) {
        console.error(chalk.red(`Search failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

function printEntity(entity: AgentSearchResponse): void {
  const status = entity.status === "active"
    ? chalk.green(entity.status)
    : chalk.yellow(entity.status ?? "unknown");

  console.log(`  ${chalk.bold.white(entity.name)} ${chalk.dim("·")} ${status}`);
  console.log(`  ${chalk.dim("ID")}       ${chalk.hex("#06B6D4")(entity.entity_id)}`);
  if (entity.summary) {
    console.log(`  ${chalk.dim("Summary")}  ${entity.summary}`);
  }
  if (entity.category) {
    console.log(`  ${chalk.dim("Category")} ${entity.category}`);
  }
  if (entity.tags && entity.tags.length > 0) {
    console.log(`  ${chalk.dim("Tags")}     ${entity.tags.join(", ")}`);
  }
  console.log(`  ${chalk.dim("URL")}      ${entity.entity_url}`);
  console.log(`  ${chalk.dim("Score")}    ${entity.score.toFixed(3)}`);
  console.log();
}

function commaSplit(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}
