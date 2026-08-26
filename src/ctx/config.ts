import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CtxConfig } from "./types.js";

export function ctxConfigPath(): string {
  const home = process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
  return path.join(home, "ctx.json");
}

export function loadCtxConfig(): CtxConfig {
  const configPath = ctxConfigPath();
  if (!fs.existsSync(configPath)) {
    return { providers: {} };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw) as CtxConfig;
  } catch (err) {
    throw new Error(`ctx.json parse error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export function saveCtxConfig(config: CtxConfig): void {
  const configPath = ctxConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getMemoryUrl(config: CtxConfig): string {
  return (
    config.memory_url ??
    process.env["ZYND_MEMORY_URL"] ??
    "https://api.zynd.ai"
  );
}

export function getRegistryUrl(config: CtxConfig): string {
  return config.registry_url ?? process.env["ZYND_REGISTRY_URL"] ?? "https://zns01.zynd.ai";
}

export function getAccessToken(config: CtxConfig): string {
  return config.access_token ?? process.env["ZYND_ACCESS_TOKEN"] ?? "";
}

/** @deprecated Use getAccessToken. Kept for local-dev fallback only. */
export function getJwtSecret(config?: CtxConfig): string {
  return (
    config?.jwt_secret ??
    process.env["MEMORY_LAYER_JWT_SECRET"] ??
    process.env["ZYND_JWT_SECRET"] ??
    ""
  );
}

export function getUserIdFromConfig(config: CtxConfig): string {
  return config.user_id ?? process.env["ZYND_USER_ID"] ?? process.env["ZYND_MEMORY_USER_ID"] ?? "";
}

/**
 * Confirm memory-layer URL is reachable by probing /health.
 * Does not authenticate — user_id and jwt_secret come from stored config or env vars.
 * Returns { url } on success or null if unreachable.
 */
export async function discoverMemoryLayer(
  candidateUrl?: string,
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
      const resp = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) return { url: base, userId: "", jwtSecret: "" };
    } catch {
      // unreachable — try next
    }
  }
  return null;
}
