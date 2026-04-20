import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadKeypair,
  saveKeypair,
  deriveAgentKeypair,
  createDerivationProof,
  generateDeveloperId,
  type Ed25519Keypair,
} from "../identity.js";
import { registerEntity } from "../registry.js";
import { loadDerivationMetadata } from "../entity-card-loader.js";
import { getRegistryUrl, agentsDir, developerKeyPath, ensureZyndDir } from "./config.js";

function nextAgentIndex(): number {
  const dir = agentsDir();
  if (!fs.existsSync(dir)) return 0;
  let index = 0;
  while (fs.existsSync(path.join(dir, `agent-${index}.json`))) index++;
  return index;
}

function deriveWithProof(devPath: string, index: number): {
  keypair: Ed25519Keypair;
  developerId: string;
  developerProof: Record<string, unknown>;
} {
  const devKp = loadKeypair(devPath);
  const keypair = deriveAgentKeypair(devKp.privateKeyBytes, index);
  const proof = createDerivationProof(devKp, keypair.publicKeyBytes, index);
  const developerId = generateDeveloperId(devKp.publicKeyBytes);

  const dir = agentsDir();
  fs.mkdirSync(dir, { recursive: true });
  saveKeypair(keypair, path.join(dir, `agent-${index}.json`), {
    developer_public_key: devKp.publicKeyString,
    entity_index: index,
  });

  return { keypair, developerId, developerProof: proof };
}

export function registerRegisterCommand(program: Command): void {
  program
    .command("register")
    .description("Register an entity on the ZyndAI registry")
    .requiredOption("--name <name>", "Entity name")
    .requiredOption("--agent-url <url>", "Public URL for the entity")
    .option("--category <category>", "Category", "general")
    .option("--tags <tags>", "Comma-separated tags", commaSplit)
    .option("--summary <text>", "Short description")
    .option("--keypair <path>", "Path to keypair JSON file")
    .option("--index <n>", "Derive from developer key at this index", parseInt)
    .option("--type <type>", "Entity type (agent|service)")
    .option("--json", "Output as JSON")
    .action(async (opts: {
      name: string;
      agentUrl: string;
      category: string;
      tags?: string[];
      summary?: string;
      keypair?: string;
      index?: number;
      type?: string;
      json?: boolean;
    }) => {
      ensureZyndDir();
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);
      const devPath = developerKeyPath();

      let keypair: Ed25519Keypair;
      let developerId: string | undefined;
      let developerProof: Record<string, unknown> | undefined;

      try {
        if (opts.keypair) {
          // Explicit keypair — check for derivation metadata to attach developer proof
          keypair = loadKeypair(opts.keypair);
          const derivation = loadDerivationMetadata(opts.keypair);
          if (derivation && fs.existsSync(devPath)) {
            const devKp = loadKeypair(devPath);
            const idx = (derivation as Record<string, unknown>).entity_index as number ??
                        (derivation as Record<string, unknown>).index as number ?? 0;
            const proof = createDerivationProof(devKp, keypair.publicKeyBytes, idx);
            developerId = generateDeveloperId(devKp.publicKeyBytes);
            developerProof = proof;
          }
        } else if (opts.index !== undefined && !isNaN(opts.index)) {
          // Explicit index — derive from developer key
          if (!fs.existsSync(devPath)) {
            console.error(chalk.red("Error: No developer keypair found. Run 'zynd init' first."));
            process.exitCode = 1;
            return;
          }
          ({ keypair, developerId, developerProof } = deriveWithProof(devPath, opts.index));
        } else {
          // No keypair or index — auto-derive at next available index
          if (!fs.existsSync(devPath)) {
            console.error(chalk.red("Error: No developer keypair found. Run 'zynd init' first."));
            process.exitCode = 1;
            return;
          }
          const index = nextAgentIndex();
          ({ keypair, developerId, developerProof } = deriveWithProof(devPath, index));
        }

        const entityId = await registerEntity({
          registryUrl,
          keypair,
          name: opts.name,
          entityUrl: opts.agentUrl,
          category: opts.category,
          tags: opts.tags,
          summary: opts.summary,
          developerId,
          developerProof,
          entityType: opts.type,
        });

        if (opts.json) {
          console.log(JSON.stringify({ entity_id: entityId, public_key: keypair.publicKeyString }));
        } else {
          console.log("Agent registered successfully!");
          console.log(`  Agent ID:   ${entityId}`);
          console.log(`  Public key: ${keypair.publicKeyString}`);
          console.log(`  Registry:   ${registryUrl}`);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

function commaSplit(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}
