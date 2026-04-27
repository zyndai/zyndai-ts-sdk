import * as fs from "node:fs";
import * as path from "node:path";
import {
  Ed25519Keypair,
  loadKeypair,
  saveKeypair,
  deriveAgentKeypair,
  generateEntityId,
} from "../identity.js";
import {
  agentsDir,
  agentKeypairPath,
  servicesDir,
  serviceKeypairPath,
  developerKeyPath,
  ensureZyndDir,
} from "./config.js";

export interface ScaffoldIdentityResult {
  keypair: Ed25519Keypair;
  keypairPath: string;
  entityId: string;
  derivationIndex: number;
  reusedExisting: boolean;
}

/**
 * Walk every agent + service keypair under ~/.zynd/ and return the next
 * unused derivation index. Matches the Python CLI scan in `_agent_init`.
 */
function nextDerivationIndex(): number {
  const used = new Set<number>();
  for (const root of [agentsDir(), servicesDir()]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      // Per-name dir layout: ~/.zynd/agents/<name>/keypair.json
      if (entry.isDirectory()) {
        const kp = path.join(root, entry.name, "keypair.json");
        collectIndex(kp, used);
        continue;
      }
      // Flat layout: ~/.zynd/agents/<name>.json (legacy / `keys derive`)
      if (entry.isFile() && entry.name.endsWith(".json")) {
        collectIndex(path.join(root, entry.name), used);
      }
    }
  }
  let idx = 0;
  while (used.has(idx)) idx++;
  return idx;
}

function collectIndex(filePath: string, used: Set<number>): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      derived_from?: { index?: number; entity_index?: number };
    };
    const idx = data.derived_from?.index ?? data.derived_from?.entity_index;
    if (typeof idx === "number") used.add(idx);
  } catch {
    // ignore unreadable files
  }
}

/**
 * Derive (or reuse) an Ed25519 keypair for `zynd agent init` /
 * `zynd service init` and save it under ~/.zynd/.
 *
 * Layout matches the Python `zynd_cli` convention:
 *   ~/.zynd/agents/<slug>/keypair.json
 *   ~/.zynd/services/<slug>/keypair.json
 *
 * Throws if the developer key (`~/.zynd/developer.json`) is missing —
 * the user must run `zynd init` first.
 */
export function scaffoldIdentity(opts: {
  name: string;
  entityType: "agent" | "service";
  index?: number;
}): ScaffoldIdentityResult {
  const devPath = developerKeyPath();
  if (!fs.existsSync(devPath)) {
    throw new Error(
      "No developer keypair found. Run `zynd init` first to create your developer identity.",
    );
  }

  ensureZyndDir();
  const keypairPath =
    opts.entityType === "service"
      ? serviceKeypairPath(opts.name)
      : agentKeypairPath(opts.name);
  fs.mkdirSync(path.dirname(keypairPath), { recursive: true });

  if (fs.existsSync(keypairPath)) {
    const kp = loadKeypair(keypairPath);
    const data = JSON.parse(fs.readFileSync(keypairPath, "utf-8")) as {
      derived_from?: { index?: number };
    };
    return {
      keypair: kp,
      keypairPath,
      entityId: generateEntityId(kp.publicKeyBytes, opts.entityType),
      derivationIndex: data.derived_from?.index ?? 0,
      reusedExisting: true,
    };
  }

  const devKp = loadKeypair(devPath);
  const index = opts.index ?? nextDerivationIndex();
  const derived = deriveAgentKeypair(devKp.privateKeyBytes, index);

  saveKeypair(derived, keypairPath, {
    developer_public_key: devKp.publicKeyB64,
    index,
  });

  return {
    keypair: derived,
    keypairPath,
    entityId: generateEntityId(derived.publicKeyBytes, opts.entityType),
    derivationIndex: index,
    reusedExisting: false,
  };
}
