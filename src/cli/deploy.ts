/**
 * `zynd deploy` — push the current project to a zynd-deployer instance.
 *
 * What it does (in order):
 *   1. Detect entity type from agent.config.json vs service.config.json
 *      sitting in cwd.
 *   2. Detect runtime/language from the config's `language` field, then
 *      file presence (agent.py/service.py → python; package.json + zyndai
 *      dep + .ts/.js entry → node). Mirrors the deployer's own detection.
 *   3. Resolve the keypair from (in order): --keypair flag, env var
 *      ZYND_{AGENT|SERVICE}_KEYPAIR_PATH (also picked up from .env),
 *      `keypair_path` field in the config, or the canonical
 *      ~/.zynd/{agents|services}/<slug>/keypair.json that scaffold-identity
 *      writes.
 *   4. Zip the project in memory, skipping node_modules/.venv/.git/dist
 *      and other VCS/build noise. Same exclusion list the deployer's
 *      validator strips on the server side, so we don't waste bytes.
 *   5. POST multipart/form-data to <deployer>/api/deployments with
 *      project.zip + keypair.json (+ optional image pin).
 *   6. Print the resulting deployment id, slug, runtime, and URL.
 *
 * The deployer also performs its own validation server-side, so this
 * command stays optimistic — we don't pre-validate beyond resolving
 * the right files.
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
import JSZip from "jszip";
import { config as loadDotenv } from "dotenv";

import { agentKeypairPath, serviceKeypairPath } from "./config.js";

interface DeployOpts {
  deployer?: string;
  keypair?: string;
  image?: string;
  language?: "ts" | "python" | "node";
  yes?: boolean;
}

interface DeployResponse {
  id: string;
  slug: string;
  status: string;
  runtime: string;
  image: string | null;
}

const ZIP_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".git",
  ".github",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
]);

const ZIP_EXCLUDE_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
]);

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy the current project to a Zynd deployer")
    .option(
      "--deployer <url>",
      "Deployer base URL (e.g. https://deploy.example.com). " +
        "Falls back to $ZYND_DEPLOYER_URL.",
    )
    .option("--keypair <path>", "Override the keypair path")
    .option(
      "--image <ref>",
      "Pin a specific zynd-labelled Docker image on the deployer (optional)",
    )
    .option(
      "--language <ts|python>",
      "Force the runtime detection. Useful when the project layout " +
        "is ambiguous. Otherwise auto-detected.",
    )
    .action(async (opts: DeployOpts) => {
      try {
        await runDeploy(opts);
      } catch (e) {
        console.error(chalk.red(`Error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    });
}

async function runDeploy(opts: DeployOpts): Promise<void> {
  const cwd = process.cwd();

  // ---- 1. Detect entity type ---------------------------------------------
  const agentCfgPath = path.join(cwd, "agent.config.json");
  const svcCfgPath = path.join(cwd, "service.config.json");
  const hasAgent = fs.existsSync(agentCfgPath);
  const hasSvc = fs.existsSync(svcCfgPath);

  if (hasAgent === hasSvc) {
    throw new Error(
      hasAgent
        ? "Found BOTH agent.config.json and service.config.json — keep only one at the project root."
        : "No agent.config.json or service.config.json in current directory. Run from a project root.",
    );
  }
  const entityType: "agent" | "service" = hasAgent ? "agent" : "service";
  const configPath = hasAgent ? agentCfgPath : svcCfgPath;
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const name = (config["name"] as string) ?? "(unnamed)";

  // ---- 2. Detect runtime --------------------------------------------------
  const runtime = detectRuntime(cwd, entityType, config, opts.language);

  // ---- 3. Detect framework (display only — server doesn't need it) -------
  const framework = detectFramework(cwd, runtime, config);

  // ---- 4. Resolve keypair -------------------------------------------------
  loadEnvIfPresent(cwd);
  const keypairFile = resolveKeypairPath(opts.keypair, entityType, config, name);
  if (!fs.existsSync(keypairFile)) {
    throw new Error(
      `Keypair not found at ${keypairFile}. ` +
        `Pass --keypair <path>, set ZYND_${entityType.toUpperCase()}_KEYPAIR_PATH, ` +
        `or scaffold one with \`zynd ${entityType} init\`.`,
    );
  }

  // ---- 5. Resolve deployer URL --------------------------------------------
  const deployerUrl = opts.deployer ?? process.env["ZYND_DEPLOYER_URL"];
  if (!deployerUrl) {
    throw new Error(
      "Deployer URL required. Pass --deployer <url> or set ZYND_DEPLOYER_URL.",
    );
  }
  const endpoint = `${deployerUrl.replace(/\/+$/, "")}/api/deployments`;

  // ---- 6. Banner ----------------------------------------------------------
  console.log(chalk.bold(`\nDeploying ${entityType} "${name}"`));
  console.log(`  Runtime:   ${runtime}`);
  if (framework) console.log(`  Framework: ${framework}`);
  console.log(`  Keypair:   ${keypairFile}`);
  console.log(`  Deployer:  ${endpoint}`);
  if (opts.image) console.log(`  Image:     ${opts.image}`);
  console.log();

  // ---- 7. Build the zip in memory ----------------------------------------
  process.stdout.write("Zipping project... ");
  const zipBuf = await zipProjectDir(cwd);
  console.log(chalk.dim(`${formatBytes(zipBuf.length)}`));

  // ---- 8. POST ------------------------------------------------------------
  process.stdout.write("Uploading... ");
  const form = new FormData();
  form.append(
    "project.zip",
    new Blob([new Uint8Array(zipBuf)], { type: "application/zip" }),
    "project.zip",
  );
  const keyBuf = fs.readFileSync(keypairFile);
  form.append(
    "keypair.json",
    new Blob([new Uint8Array(keyBuf)], { type: "application/json" }),
    "keypair.json",
  );
  if (opts.image) form.append("image", opts.image);

  const resp = await fetch(endpoint, { method: "POST", body: form });
  console.log();

  if (!resp.ok) {
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      body = await resp.text();
    }
    const errMsg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    throw new Error(`Deployer returned HTTP ${resp.status}: ${errMsg}`);
  }

  const dep = (await resp.json()) as DeployResponse;

  console.log(chalk.green("Deployment created."));
  console.log(`  ID:      ${dep.id}`);
  console.log(`  Slug:    ${dep.slug}`);
  console.log(`  Status:  ${dep.status}`);
  console.log(`  Runtime: ${dep.runtime}`);
  if (dep.image) console.log(`  Image:   ${dep.image}`);
  console.log();
  console.log(
    `Live URL: ${chalk.cyan(`${deployerUrl.replace(/\/+$/, "")}/d/${dep.id}`)}`,
  );
  console.log(`Logs:     ${deployerUrl.replace(/\/+$/, "")}/api/deployments/${dep.id}/logs`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectRuntime(
  cwd: string,
  entityType: "agent" | "service",
  config: Record<string, unknown>,
  override: DeployOpts["language"] | undefined,
): "python" | "node" {
  if (override === "python") return "python";
  if (override === "ts" || override === "node") return "node";

  const lang = config["language"];
  if (typeof lang === "string") {
    if (lang === "python" || lang === "py") return "python";
    if (lang === "ts" || lang === "js" || lang === "node") return "node";
  }

  const hasPy = fs.existsSync(path.join(cwd, `${entityType}.py`));
  const hasTs =
    fs.existsSync(path.join(cwd, `${entityType}.ts`)) ||
    fs.existsSync(path.join(cwd, `${entityType}.mjs`)) ||
    fs.existsSync(path.join(cwd, `${entityType}.js`));
  const hasPkgJson = fs.existsSync(path.join(cwd, "package.json"));

  if (hasPy && (hasTs || hasPkgJson)) {
    throw new Error(
      "Project contains both Python and Node entry files. " +
        'Pass --language ts or --language python, or add a "language" field to your config.',
    );
  }
  if (hasPy) return "python";
  if (hasTs || hasPkgJson) return "node";
  throw new Error(
    `Could not detect runtime. Expected ${entityType}.py (Python) or ${entityType}.ts/package.json (Node).`,
  );
}

function detectFramework(
  cwd: string,
  runtime: "python" | "node",
  config: Record<string, unknown>,
): string | null {
  const fromConfig = config["framework"];
  if (typeof fromConfig === "string") return fromConfig;

  if (runtime === "python") {
    const reqPath = path.join(cwd, "requirements.txt");
    if (fs.existsSync(reqPath)) {
      const text = fs.readFileSync(reqPath, "utf-8").toLowerCase();
      if (text.includes("langgraph")) return "langgraph";
      if (text.includes("crewai")) return "crewai";
      if (text.includes("pydantic-ai")) return "pydantic_ai";
      if (text.includes("langchain")) return "langchain";
    }
  } else {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          dependencies?: Record<string, unknown>;
        };
        const deps = { ...(pkg.dependencies ?? {}) };
        if ("@mastra/core" in deps) return "mastra";
        if ("@langchain/langgraph" in deps) return "langgraph";
        if ("langchain" in deps) return "langchain";
        if ("ai" in deps && "@ai-sdk/openai" in deps) return "vercel_ai";
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function loadEnvIfPresent(cwd: string): void {
  const envPath = path.join(cwd, ".env");
  if (fs.existsSync(envPath)) loadDotenv({ path: envPath });
}

function resolveKeypairPath(
  override: string | undefined,
  entityType: "agent" | "service",
  config: Record<string, unknown>,
  name: string,
): string {
  if (override) return path.resolve(override);

  const envName =
    entityType === "agent"
      ? "ZYND_AGENT_KEYPAIR_PATH"
      : "ZYND_SERVICE_KEYPAIR_PATH";
  if (process.env[envName]) {
    return path.resolve(process.env[envName] as string);
  }

  const fromConfig = config["keypair_path"];
  if (typeof fromConfig === "string" && fromConfig) {
    return path.resolve(fromConfig);
  }

  return entityType === "agent"
    ? agentKeypairPath(name)
    : serviceKeypairPath(name);
}

async function zipProjectDir(rootAbs: string): Promise<Buffer> {
  const zip = new JSZip();
  await addDirToZip(zip, rootAbs, "");
  return await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function addDirToZip(
  zip: JSZip,
  absDir: string,
  zipPrefix: string,
): Promise<void> {
  const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.isDirectory()) {
      if (ZIP_EXCLUDE_DIRS.has(entry.name)) continue;
      await addDirToZip(
        zip,
        path.join(absDir, entry.name),
        zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name,
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (ZIP_EXCLUDE_FILES.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const data = await fs.promises.readFile(abs);
    zip.file(zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name, data);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
