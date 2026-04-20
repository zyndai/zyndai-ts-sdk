import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_REGISTRY_URL = "https://dns01.zynd.ai";

export function zyndDir(): string {
  return path.join(os.homedir(), ".zynd");
}

export function ensureZyndDir(): string {
  const dir = zyndDir();
  fs.mkdirSync(dir, { recursive: true });
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
