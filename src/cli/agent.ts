import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRAMEWORKS_BY_LANG,
  FRAMEWORK_ORDER_BY_LANG,
  LANGUAGES,
  LANGUAGE_LABELS,
  templateFileForFramework,
  payloadTemplateFile,
  entryExtension,
  type Language,
} from "../templates/frameworks.js";
import { pickOption, promptText } from "./prompts.js";
import {
  parseDepsFromInstall,
  writeGitignore,
  writeTsConfig,
  writeTsPackageJson,
} from "./scaffold-ts.js";
import { scaffoldIdentity } from "./scaffold-identity.js";

/**
 * Resolve the directory containing bundled .tpl templates.
 * Matches the build step that copies src/templates/** into dist/templates/**.
 */
function templatesDir(): string {
  const here =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "templates");
}

function loadTemplate(relPath: string): string | null {
  const p = path.join(templatesDir(), relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}

function isLanguage(v: string): v is Language {
  return (LANGUAGES as readonly string[]).includes(v);
}

async function resolveLanguage(flag: string | undefined): Promise<Language> {
  if (flag) {
    if (!isLanguage(flag)) {
      throw new Error(
        `Invalid --lang: ${flag}. Must be one of: ${LANGUAGES.join(", ")}`,
      );
    }
    return flag;
  }
  const picked = await pickOption("Select a language", [
    { key: "ts", label: "TypeScript", description: "Node.js agent — npm, tsx, Zod" },
    { key: "py", label: "Python", description: "Python agent — pip, pydantic" },
  ]);
  return picked.key as Language;
}

async function resolveFramework(lang: Language, flag: string | undefined): Promise<string> {
  const registry = FRAMEWORKS_BY_LANG[lang];
  const order = FRAMEWORK_ORDER_BY_LANG[lang];
  if (flag) {
    if (!(flag in registry)) {
      throw new Error(
        `Invalid --framework for ${LANGUAGE_LABELS[lang]}: ${flag}. Must be one of: ${order.join(", ")}`,
      );
    }
    return flag;
  }
  const options = order.map((key) => ({
    key,
    label: registry[key].label,
    description: registry[key].description,
  }));
  const picked = await pickOption(
    `Select a framework (${LANGUAGE_LABELS[lang]})`,
    options,
  );
  return picked.key;
}

async function resolveName(flag: string | undefined, cwd: string): Promise<string> {
  if (flag) return flag;
  const def = path.basename(cwd);
  const name = await promptText("Agent name", def);
  if (!name) throw new Error("Agent name is required.");
  return name;
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Agent project management");

  agent
    .command("init")
    .description("Scaffold a new agent project in the current directory (TypeScript or Python)")
    .option("--lang <lang>", "Target language (ts|py) — prompts if omitted")
    .option("--framework <framework>", "Framework key — prompts if omitted")
    .option("--name <name>", "Agent name — prompts if omitted")
    .action(
      async (opts: { lang?: string; framework?: string; name?: string }) => {
        const cwd = process.cwd();

        let lang: Language;
        let framework: string;
        let name: string;
        try {
          lang = await resolveLanguage(opts.lang);
          framework = await resolveFramework(lang, opts.framework);
          name = await resolveName(opts.name, cwd);
        } catch (err) {
          console.error(
            chalk.red(err instanceof Error ? err.message : String(err)),
          );
          process.exitCode = 1;
          return;
        }

        const fwMeta = FRAMEWORKS_BY_LANG[lang][framework];
        const ext = entryExtension(lang);

        // Project layout (matches Python `zynd_cli`):
        //   agent.config.json + agent.{ts,py} + payload.{ts,py} + .well-known/
        // The agent's keypair lives under ~/.zynd/agents/<slug>/keypair.json,
        // referenced from .env via ZYND_AGENT_KEYPAIR_PATH.
        const configFilePath = path.join(cwd, "agent.config.json");
        const entryFile = path.join(cwd, `agent.${ext}`);
        const payloadFile = path.join(cwd, `payload.${ext}`);

        if (fs.existsSync(configFilePath)) {
          console.error(
            chalk.yellow(
              `${path.relative(cwd, configFilePath)} already exists. This directory is already an agent project.`,
            ),
          );
          process.exitCode = 1;
          return;
        }

        // Generate (or reuse) the agent's Ed25519 keypair under ~/.zynd/.
        let identity: ReturnType<typeof scaffoldIdentity>;
        try {
          identity = scaffoldIdentity({ name, entityType: "agent" });
        } catch (err) {
          console.error(
            chalk.red(err instanceof Error ? err.message : String(err)),
          );
          process.exitCode = 1;
          return;
        }

        const configPayload: Record<string, unknown> = {
          name,
          framework,
          language: lang,
          description: `${name} agent`,
          category: "general",
          tags: [],
          summary: "",
          registry_url: "https://dns01.zynd.ai",
          webhook_port: 5000,
          entity_index: identity.derivationIndex,
        };
        fs.writeFileSync(configFilePath, JSON.stringify(configPayload, null, 2));

        // .env with registry URL, keypair path, and framework's expected API keys.
        // Keypair path is absolute — keypair lives outside the project dir.
        const envPath = path.join(cwd, ".env");
        if (!fs.existsSync(envPath)) {
          const envLines = [
            `ZYND_AGENT_KEYPAIR_PATH=${identity.keypairPath}`,
            `ZYND_REGISTRY_URL=https://dns01.zynd.ai`,
            "",
          ];
          for (const key of fwMeta.envKeys) envLines.push(`${key}=`);
          fs.writeFileSync(envPath, envLines.join("\n") + "\n");
        }

        // Framework-specific entry file (agent.ts or agent.py).
        const tplRel = templateFileForFramework(lang, framework);
        const template = loadTemplate(tplRel);
        if (template) {
          if (!fs.existsSync(entryFile)) {
            fs.writeFileSync(
              entryFile,
              template.replace(/__AGENT_NAME__/g, name),
            );
          }
        } else {
          console.warn(chalk.yellow(`Warning: template not found: ${tplRel}`));
        }

        // Shared payload schema.
        const payloadTpl = loadTemplate(payloadTemplateFile(lang));
        if (payloadTpl && !fs.existsSync(payloadFile)) {
          fs.writeFileSync(
            payloadFile,
            payloadTpl.replace(/__AGENT_NAME__/g, name),
          );
        }

        // TS-only project files: package.json, tsconfig.json, .gitignore.
        let pkgWritten = false;
        if (lang === "ts") {
          pkgWritten = writeTsPackageJson({
            cwd,
            name,
            deps: parseDepsFromInstall(fwMeta.install),
            entryFile: `agent.${ext}`,
            runCommand: "zynd agent run",
          });
          writeTsConfig(cwd);
          writeGitignore(cwd);
        }

        // .well-known placeholder — regenerated on first `zynd agent run`.
        const wellKnownDir = path.join(cwd, ".well-known");
        fs.mkdirSync(wellKnownDir, { recursive: true });
        const wkFile = path.join(wellKnownDir, "agent.json");
        if (!fs.existsSync(wkFile)) {
          fs.writeFileSync(
            wkFile,
            JSON.stringify(
              {
                _note:
                  "This file is auto-generated when the agent runs. Do not edit manually.",
              },
              null,
              2,
            ),
          );
        }

        console.log();
        console.log(chalk.green(`Agent "${name}" scaffolded (${LANGUAGE_LABELS[lang]}).`));
        console.log();
        console.log(`  ${chalk.dim("Language")}    ${LANGUAGE_LABELS[lang]}`);
        console.log(`  ${chalk.dim("Framework")}   ${fwMeta.label}`);
        console.log(`  ${chalk.dim("Config")}      ${path.relative(cwd, configFilePath)}`);
        console.log(`  ${chalk.dim("Entry")}       agent.${ext}`);
        console.log(`  ${chalk.dim("Payload")}     payload.${ext}`);
        console.log(`  ${chalk.dim("Env")}         .env`);
        console.log(
          `  ${chalk.dim("Keypair")}     ${identity.keypairPath}${identity.reusedExisting ? chalk.dim(" (reused)") : ""}`,
        );
        console.log(
          `  ${chalk.dim("Entity ID")}   ${chalk.hex("#06B6D4")(identity.entityId)}`,
        );
        console.log(
          `  ${chalk.dim("Derived")}     from developer key (index ${identity.derivationIndex})`,
        );
        console.log();
        console.log(chalk.bold("  Next steps:"));
        let step = 1;
        if (lang === "ts") {
          const installCmd = pkgWritten ? "npm install" : fwMeta.install;
          console.log(`    ${step++}. Install deps: ${chalk.cyan(installCmd)}`);
        } else {
          console.log(`    ${step++}. Install deps: ${chalk.cyan(fwMeta.install)}`);
        }
        if (fwMeta.envKeys.length > 0) {
          console.log(`    ${step++}. Add your API keys to ${chalk.cyan(".env")}`);
        }
        console.log(`    ${step}. Run: ${chalk.cyan("zynd agent run")}`);
      },
    );

  agent
    .command("run")
    .description("Start the agent from the current directory (auto-detects TS or Python)")
    .option("--port <port>", "Override webhook port", parseInt)
    .action(async (opts: { port?: number }) => {
      const cwd = process.cwd();

      // Project config: agent.config.json in cwd. Older TS layout
      // (.agent/agent.json) still recognized for backward compatibility.
      const newConfigPath = path.join(cwd, "agent.config.json");
      const legacyConfigPath = path.join(cwd, ".agent", "agent.json");
      const configPath = fs.existsSync(newConfigPath)
        ? newConfigPath
        : fs.existsSync(legacyConfigPath)
          ? legacyConfigPath
          : null;

      if (!configPath) {
        console.error(
          chalk.red(
            "No agent.config.json found in current directory. Run: zynd agent init",
          ),
        );
        process.exitCode = 1;
        return;
      }

      const raw = JSON.parse(
        fs.readFileSync(configPath, "utf-8"),
      ) as Record<string, unknown>;
      const name = (raw["name"] as string) ?? "unnamed-agent";
      const port = opts.port ?? (raw["webhook_port"] as number) ?? 5000;

      console.log(chalk.dim(`Starting agent "${name}" on port ${port}...`));
      console.log();

      // Candidate entry files, preferring the language recorded in config.
      const declaredLang = raw["language"] as string | undefined;
      const tsEntries = ["agent.ts", "agent.js", "agent.mjs", "agent.cjs"];
      const pyEntries = ["agent.py"];
      const entries = declaredLang === "py" ? [...pyEntries, ...tsEntries] : [...tsEntries, ...pyEntries];

      const entry = entries
        .map((f) => path.join(cwd, f))
        .find((f) => fs.existsSync(f));

      if (entry) {
        const { spawn } = await import("node:child_process");
        const env = { ...process.env };
        if (opts.port) env["WEBHOOK_PORT"] = String(opts.port);

        let cmd: string;
        let args: string[];
        if (entry.endsWith(".ts")) {
          cmd = "npx";
          args = ["tsx", entry];
        } else if (entry.endsWith(".py")) {
          cmd = process.platform === "win32" ? "python" : "python3";
          args = [entry];
        } else {
          cmd = "node";
          args = [entry];
        }

        const child = spawn(cmd, args, { stdio: "inherit", env });
        child.on("exit", (code) => {
          process.exitCode = code ?? 0;
        });
        return;
      }

      // Fallback: TS in-process echo so registration/heartbeat can be tested.
      try {
        const { ZyndAIAgent } = await import("../agent.js");
        const { AgentConfigSchema } = await import("../types.js");
        const config = AgentConfigSchema.parse({
          name,
          description: (raw["description"] as string) ?? "",
          category: (raw["category"] as string) ?? "general",
          tags: (raw["tags"] as string[]) ?? [],
          registryUrl:
            (raw["registry_url"] as string) ?? "https://dns01.zynd.ai",
          webhookPort: port,
        });
        const agentInstance = new ZyndAIAgent(config);
        agentInstance.setCustomAgent((input: string) => `Echo: ${input}`);
        await agentInstance.start();
      } catch (err) {
        console.error(
          chalk.red(
            `Agent failed to start: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
