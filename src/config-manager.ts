import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeypair, loadKeypair, deriveAgentKeypair, Ed25519Keypair } from "./identity.js";
import { registerEntity } from "./registry.js";
import { AgentConfigFile, ZyndBaseConfig } from "./types.js";

/**
 * Path to ~/.zynd/config.json — where the CLI persists the user's chosen
 * default registry (and other per-developer settings). $ZYND_HOME overrides
 * the home directory, matching the CLI's resolution rules.
 */
function homeConfigPath(): string {
  const home = process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
  return path.join(home, "config.json");
}

/**
 * Read the developer's chosen default registry URL from ~/.zynd/config.json.
 * Returns null when the file doesn't exist or doesn't carry a registry_url
 * field. This is the post-`zynd auth login` source of truth — every CLI
 * command and SDK runtime path consults it before falling back to the
 * hardcoded default.
 */
export function loadHomeRegistryUrl(): string | null {
  const p = homeConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { registry_url?: string };
    return typeof data.registry_url === "string" && data.registry_url ? data.registry_url : null;
  } catch {
    return null;
  }
}

/**
 * Derive a search-snippet summary from a longer description. Cuts at the
 * first sentence boundary or 160 chars, whichever is shorter. Mirrors the
 * `summarize()` helper in base.ts so the registry sees the same value
 * regardless of whether registration happens through ConfigManager
 * (initial create) or through ZyndBase.upsertOnRegistry (subsequent runs).
 */
function deriveSummary(text: string, maxLen = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= maxLen) return collapsed;
  const firstSentence = collapsed.match(/^(.{20,160}?[.!?])(\s|$)/);
  if (firstSentence) return firstSentence[1].trim();
  return collapsed.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Standard registry-URL resolution chain used by the SDK runtime and CLI:
 *
 *   1. explicit override (caller-supplied)
 *   2. $ZYND_REGISTRY_URL env var       — ephemeral override (e.g. localhost dev)
 *   3. ~/.zynd/config.json registry_url — the developer's logged-in registry
 *                                         (set by `zynd auth login --registry`)
 *   4. project config field             — fallback for projects that bake a URL
 *   5. https://zns01.zynd.ai            — last-resort default
 *
 * Priority 3 wins over the project config so that once a developer logs into
 * an organization's registry, every project they touch targets that registry
 * — they don't have to remember to update each project's *.config.json.
 * Override knobs (1 and 2) still trump it for explicit per-call routing.
 */
export function resolveRegistryUrl(opts: {
  override?: string | undefined;
  fromConfigFile?: string | undefined;
} = {}): string {
  if (opts.override) return opts.override;
  const env = process.env["ZYND_REGISTRY_URL"];
  if (env) return env;
  const home = loadHomeRegistryUrl();
  if (home) return home;
  if (opts.fromConfigFile) return opts.fromConfigFile;
  return "https://zns01.zynd.ai";
}

const DEFAULT_CONFIG_DIR = ".agent";
const CONFIG_FILE = "config.json";

function configPath(configDir?: string): string {
  const dir = configDir ?? DEFAULT_CONFIG_DIR;
  return path.join(process.cwd(), dir, CONFIG_FILE);
}

function configDirPath(configDir?: string): string {
  const dir = configDir ?? DEFAULT_CONFIG_DIR;
  return path.join(process.cwd(), dir);
}

export class ConfigManager {
  /** Load existing config from <cwd>/<configDir>/config.json or null. */
  static loadConfig(configDir?: string): AgentConfigFile | null {
    const filePath = configPath(configDir);
    if (!fs.existsSync(filePath)) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read config at ${filePath}`, { cause: err });
    }

    try {
      return JSON.parse(raw) as AgentConfigFile;
    } catch {
      return null;
    }
  }

  /** Persist config to <cwd>/<configDir>/config.json. */
  static saveConfig(config: AgentConfigFile, configDir?: string): void {
    const dirPath = configDirPath(configDir);
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = configPath(configDir);
    try {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (err) {
      throw new Error(`Failed to write config to ${filePath}`, { cause: err });
    }
  }

  /** Create a new agent — generate (or derive) a keypair, register, save. */
  static async createAgent(
    agentConfig: ZyndBaseConfig & { developerKeypairPath?: string; entityIndex?: number },
    configDir?: string,
  ): Promise<AgentConfigFile> {
    const keypair = resolveKeypair(agentConfig);
    const entityUrl = buildEntityUrl(agentConfig);

    let entityId = keypair.entityId;
    try {
      entityId = await registerEntity({
        registryUrl: agentConfig.registryUrl,
        keypair,
        name: agentConfig.name,
        entityUrl,
        category: agentConfig.category,
        tags: agentConfig.tags,
        // The registry's `summary` is a search-snippet derived from the
        // longer `description` — same logic the SDK uses at heartbeat
        // upsert time. See base.ts `summarize()`. Falls back to the
        // agent name when description is empty so search snippets are
        // never blank.
        summary: deriveSummary(agentConfig.description ?? "") || agentConfig.name,
      });
    } catch {
      // Registration is best-effort. Agent operates with local identity only.
    }

    const config: AgentConfigFile = {
      schema_version: "2.0",
      entity_id: entityId,
      public_key: keypair.publicKeyString,
      private_key: keypair.privateKeyB64,
      name: agentConfig.name,
      description: agentConfig.description,
      entity_url: entityUrl,
      registry_url: agentConfig.registryUrl,
      created_at: new Date().toISOString(),
    };

    ConfigManager.saveConfig(config, configDir);
    return config;
  }

  /** Load existing config or create a new agent if none is found. */
  static async loadOrCreate(
    agentConfig: ZyndBaseConfig & { developerKeypairPath?: string; entityIndex?: number },
  ): Promise<AgentConfigFile> {
    const configDir = agentConfig.configDir;
    const existing = ConfigManager.loadConfig(configDir);
    if (existing !== null) return existing;

    if (!agentConfig.name) {
      throw new Error("name is required in AgentConfig to create a new agent.");
    }

    return ConfigManager.createAgent(agentConfig, configDir);
  }
}

/**
 * Pick a keypair: derived (when developerKeypairPath + entityIndex) or
 * fresh-random.
 */
function resolveKeypair(
  agentConfig: { developerKeypairPath?: string; entityIndex?: number },
): Ed25519Keypair {
  if (agentConfig.developerKeypairPath !== undefined && agentConfig.entityIndex !== undefined) {
    const devKp = loadKeypair(agentConfig.developerKeypairPath);
    return deriveAgentKeypair(devKp.privateKeyBytes, agentConfig.entityIndex);
  }
  return generateKeypair();
}

/**
 * Resolve the public URL advertised to the registry.
 *
 * Priority:
 *   1. entityUrl       → explicit public URL (preferred)
 *   2. host/port       → derived from serverHost / serverPort
 *
 * 0.0.0.0 is rewritten to localhost so the URL is dialable. Port 443 → https.
 */
export function buildEntityUrl(agentConfig: ZyndBaseConfig): string {
  if (agentConfig.entityUrl) {
    return agentConfig.entityUrl.replace(/\/+$/, "");
  }
  const host = agentConfig.serverHost === "0.0.0.0" ? "localhost" : agentConfig.serverHost;
  const port = agentConfig.serverPort;
  const scheme = port === 443 ? "https" : "http";
  return `${scheme}://${host}:${port}`;
}
