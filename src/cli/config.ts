import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_REGISTRY_URL = "https://dns01.zynd.ai";

export function zyndDir(): string {
  return process.env.ZYND_HOME ?? path.join(os.homedir(), ".zynd");
}

export function ensureZyndDir(): string {
  const dir = zyndDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "services"), { recursive: true });
  return dir;
}

export function developerKeyPath(): string {
  return path.join(zyndDir(), "developer.json");
}

export function agentsDir(): string {
  return path.join(zyndDir(), "agents");
}

export function servicesDir(): string {
  return path.join(zyndDir(), "services");
}

/** Slugify an entity name to match Python: lowercase, spaces → hyphens. */
export function slugifyEntityName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/** Path to ~/.zynd/agents/<slug>/ for a named agent. */
export function agentDir(name: string): string {
  return path.join(agentsDir(), slugifyEntityName(name));
}

/** Path to ~/.zynd/agents/<slug>/keypair.json. */
export function agentKeypairPath(name: string): string {
  return path.join(agentDir(name), "keypair.json");
}

/** Path to ~/.zynd/services/<slug>/. */
export function serviceDir(name: string): string {
  return path.join(servicesDir(), slugifyEntityName(name));
}

/** Path to ~/.zynd/services/<slug>/keypair.json. */
export function serviceKeypairPath(name: string): string {
  return path.join(serviceDir(name), "keypair.json");
}

export function cliConfigPath(): string {
  return path.join(zyndDir(), "config.json");
}

export interface CliConfig {
  registry_url?: string;
  [key: string]: unknown;
}

export function loadCliConfig(): CliConfig {
  const p = cliConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as CliConfig;
  } catch {
    return {};
  }
}

export function saveCliConfig(data: CliConfig): void {
  ensureZyndDir();
  fs.writeFileSync(cliConfigPath(), JSON.stringify(data, null, 2));
}

export function getRegistryUrl(override?: string): string {
  if (override) return override;
  if (process.env.ZYND_REGISTRY_URL) return process.env.ZYND_REGISTRY_URL;
  const cfg = loadCliConfig();
  return cfg.registry_url ?? DEFAULT_REGISTRY_URL;
}
