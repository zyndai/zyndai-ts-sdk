import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeypair, loadKeypair, deriveAgentKeypair, Ed25519Keypair } from "./identity";
import { registerEntity } from "./registry";
import { AgentConfigFile, ZyndBaseConfig } from "./types";

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
  /**
   * Load existing config from <cwd>/<configDir>/config.json.
   * Returns null when the file does not exist or contains malformed JSON.
   */
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
      // Corrupted JSON — treat as missing so caller can create a fresh agent.
      return null;
    }
  }

  /**
   * Persist config to <cwd>/<configDir>/config.json, creating the directory
   * if it does not already exist.
   */
  static saveConfig(config: AgentConfigFile, configDir?: string): void {
    const dirPath = configDirPath(configDir);
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = configPath(configDir);
    try {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      throw new Error(`Failed to write config to ${filePath}`, { cause: err });
    }
  }

  /**
   * Create a new agent: generate (or derive) a keypair, register on the
   * registry, and save the config. Registration failures are non-fatal —
   * the agent gets a local identity and can retry registration later.
   */
  static async createAgent(
    agentConfig: ZyndBaseConfig & { developerKeypairPath?: string; entityIndex?: number },
    configDir?: string
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
        summary: agentConfig.summary,
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

  /**
   * Load an existing config or create a new agent if none is found.
   * Config directory is read from agentConfig.configDir if provided.
   */
  static async loadOrCreate(
    agentConfig: ZyndBaseConfig & { developerKeypairPath?: string; entityIndex?: number }
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
 * Resolve which keypair to use for the agent.
 *
 * If both developerKeypairPath and entityIndex are present, derive
 * deterministically from the developer key at that index. Otherwise
 * generate a fresh random keypair.
 */
function resolveKeypair(
  agentConfig: { developerKeypairPath?: string; entityIndex?: number }
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
 *   1. entityUrl — explicit public URL (preferred)
 *   2. webhookUrl — deprecated alias; accepted but flagged in docs
 *   3. Derived from webhookHost / webhookPort. Maps 0.0.0.0 → localhost.
 *      Port 443 → https; all other ports → http.
 */
export function buildEntityUrl(agentConfig: ZyndBaseConfig): string {
  if (agentConfig.entityUrl) {
    return stripWebhookSuffix(agentConfig.entityUrl);
  }

  if (agentConfig.webhookUrl) {
    return stripWebhookSuffix(agentConfig.webhookUrl);
  }

  const host = agentConfig.webhookHost === "0.0.0.0" ? "localhost" : agentConfig.webhookHost;
  const port = agentConfig.webhookPort;
  const scheme = port === 443 ? "https" : "http";
  return `${scheme}://${host}:${port}`;
}

function stripWebhookSuffix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/webhook") ? trimmed.slice(0, -"/webhook".length) : trimmed;
}

