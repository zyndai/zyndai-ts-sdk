import * as fs from "node:fs";
import * as path from "node:path";

export interface LogoVariant {
  url: string;
  width: number;
  height: number;
}

/**
 * All logo URLs exposed in the agent card.
 *
 * File naming convention (inside assets/):
 *   logo.png             → default (served at GET /logo.png)
 *   logo@512x512.png     → size variant (served at GET /logo/512x512.png)
 *   logo@1080x720.png    → size variant (served at GET /logo/1080x720.png)
 */
export interface AgentLogos {
  default: string;
  variants: LogoVariant[];
}

/**
 * Scan an assets directory for logo.png and logo@WxH.png files.
 * Returns null when assets/logo.png does not exist.
 */
export function scanLogos(assetsDir: string, baseUrl: string): AgentLogos | null {
  const base = baseUrl.replace(/\/+$/, "");

  let hasDefault: boolean;
  try {
    hasDefault = fs.existsSync(path.join(assetsDir, "logo.png"));
  } catch {
    return null;
  }
  if (!hasDefault) return null;

  const variants: LogoVariant[] = [];
  try {
    for (const file of fs.readdirSync(assetsDir).sort()) {
      const m = file.match(/^logo@(\d+)x(\d+)\.png$/);
      if (!m) continue;
      const width = parseInt(m[1], 10);
      const height = parseInt(m[2], 10);
      variants.push({ url: `${base}/logo/${width}x${height}.png`, width, height });
    }
  } catch {
    // Non-fatal — just return default-only result.
  }

  return { default: `${base}/logo.png`, variants };
}
