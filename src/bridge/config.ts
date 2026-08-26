import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeConfig } from "./types.js";

function zynd_dir(): string {
  return process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
}

export function bridgeConfigPath(): string {
  return path.join(zynd_dir(), "bridge.json");
}

/** @deprecated kept so old ctx.json is migrated on first load */
function legacyCtxConfigPath(): string {
  return path.join(zynd_dir(), "ctx.json");
}

export function loadBridgeConfig(): BridgeConfig {
  const bridgePath = bridgeConfigPath();

  // Prefer bridge.json; fall back to ctx.json (migrate transparently)
  const configPath = fs.existsSync(bridgePath)
    ? bridgePath
    : fs.existsSync(legacyCtxConfigPath())
    ? legacyCtxConfigPath()
    : null;

  if (!configPath) return { providers: {} };

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as BridgeConfig;

    // Auto-migrate: rewrite as bridge.json when we read from ctx.json
    if (configPath !== bridgePath) {
      saveBridgeConfig(config);
    }

    return config;
  } catch (err) {
    throw new Error(
      `bridge.json parse error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

export function saveBridgeConfig(config: BridgeConfig): void {
  const configPath = bridgeConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getMemoryUrl(config: BridgeConfig): string {
  return config.memory_url ?? process.env["ZYND_MEMORY_URL"] ?? "https://api.zynd.ai";
}

export function getRegistryUrl(config: BridgeConfig): string {
  return config.registry_url ?? process.env["ZYND_REGISTRY_URL"] ?? "https://zns01.zynd.ai";
}

export function getAccessToken(config: BridgeConfig): string {
  return config.access_token ?? process.env["ZYND_ACCESS_TOKEN"] ?? "";
}

/** @deprecated Use getAccessToken. Kept for local-dev fallback only. */
export function getJwtSecret(config?: BridgeConfig): string {
  return (
    config?.jwt_secret ??
    process.env["MEMORY_LAYER_JWT_SECRET"] ??
    process.env["ZYND_JWT_SECRET"] ??
    ""
  );
}

export function getUserIdFromConfig(config: BridgeConfig): string {
  return (
    config.user_id ??
    process.env["ZYND_USER_ID"] ??
    process.env["ZYND_MEMORY_USER_ID"] ??
    ""
  );
}

export async function discoverMemoryLayer(
  candidateUrl?: string
): Promise<{ url: string; userId: string; jwtSecret: string } | null> {
  const seen = new Set<string>();
  const candidates = [
    ...(candidateUrl ? [candidateUrl.replace(/\/$/, "")] : []),
    "https://api.zynd.ai",
    "http://localhost:8000",
  ].filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  for (const base of candidates) {
    try {
      const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      if (resp.ok) return { url: base, userId: "", jwtSecret: "" };
    } catch {
      // unreachable — try next
    }
  }
  return null;
}

// ─── Backward-compat aliases (src/cli/ctx.ts used these names) ───────────────
export const ctxConfigPath = bridgeConfigPath;
export const loadCtxConfig = loadBridgeConfig;
export const saveCtxConfig = saveBridgeConfig;
