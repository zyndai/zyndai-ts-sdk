import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  serviceTemplateFile,
  payloadTemplateFile,
  entryExtension,
  type Language,
} from "../templates/frameworks.js";
import { pickOption, promptText } from "./prompts.js";
import {
  writeGitignore,
  writeTsConfig,
  writeTsPackageJson,
} from "./scaffold-ts.js";
import { scaffoldIdentity } from "./scaffold-identity.js";

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
    { key: "ts", label: "TypeScript", description: "Node.js service — npm, tsx, Zod" },
    { key: "py", label: "Python", description: "Python service — pip, pydantic" },
  ]);
  return picked.key as Language;
}

async function resolveName(flag: string | undefined, cwd: string): Promise<string> {
  if (flag) return flag;
  const def = path.basename(cwd);
  const name = await promptText("Service name", def);
  if (!name) throw new Error("Service name is required.");
  return name;
}

export function registerServiceCommand(program: Command): void {
  const service = program
    .command("service")
    .description("Service project management");

  service
    .command("init")
    .description("Scaffold a new service project in the current directory (TypeScript or Python)")
    .option("--lang <lang>", "Target language (ts|py) — prompts if omitted")
    .option("--name <name>", "Service name — prompts if omitted")
    .action(async (opts: { lang?: string; name?: string }) => {
      const cwd = process.cwd();

      let lang: Language;
      let name: string;
      try {
        lang = await resolveLanguage(opts.lang);
        name = await resolveName(opts.name, cwd);
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
        return;
      }

      const ext = entryExtension(lang);

      // Project layout (matches Python `zynd_cli`):
      //   service.config.json + service.{ts,py} + payload.{ts,py} + .well-known/
      // Keypair lives under ~/.zynd/services/<slug>/keypair.json.
      const configFilePath = path.join(cwd, "service.config.json");
      const entryFile = path.join(cwd, `service.${ext}`);
      const payloadFile = path.join(cwd, `payload.${ext}`);

      if (fs.existsSync(configFilePath)) {
        console.error(
          chalk.yellow(
            `${path.relative(cwd, configFilePath)} already exists. This directory is already a service project.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      // Generate (or reuse) Ed25519 keypair under ~/.zynd/.
      let identity: ReturnType<typeof scaffoldIdentity>;
      try {
        identity = scaffoldIdentity({ name, entityType: "service" });
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
        return;
      }

      const serviceJson = {
        name,
        language: lang,
        description: `${name} service`,
        category: "general",
        tags: [],
        summary: "",
        registry_url: "https://dns01.zynd.ai",
        webhook_port: 5000,
        entity_index: identity.derivationIndex,
      };

      fs.writeFileSync(configFilePath, JSON.stringify(serviceJson, null, 2));

      // .env scaffold. Keypair path is absolute — file lives outside the project.
      const envPath = path.join(cwd, ".env");
      if (!fs.existsSync(envPath)) {
        fs.writeFileSync(
          envPath,
          [
            `ZYND_SERVICE_KEYPAIR_PATH=${identity.keypairPath}`,
            `ZYND_REGISTRY_URL=https://dns01.zynd.ai`,
            "",
          ].join("\n"),
        );
      }

      // Entry file: service.ts or service.py.
      const serviceTpl = loadTemplate(serviceTemplateFile(lang));
      if (serviceTpl) {
        if (!fs.existsSync(entryFile)) {
          fs.writeFileSync(
            entryFile,
            serviceTpl.replace(/__SERVICE_NAME__/g, name),
          );
        }
      } else {
        console.warn(
          chalk.yellow(`Warning: template not found: ${serviceTemplateFile(lang)}`),
        );
      }

      // Payload schema.
      const payloadTpl = loadTemplate(payloadTemplateFile(lang));
      if (payloadTpl && !fs.existsSync(payloadFile)) {
        // payload.tpl uses __AGENT_NAME__ as the entity name placeholder
        // (both agents and services reuse the same payload skeleton).
        fs.writeFileSync(
          payloadFile,
          payloadTpl.replace(/__AGENT_NAME__/g, name),
        );
      }

      // TS-only project files.
      let pkgWritten = false;
      if (lang === "ts") {
        pkgWritten = writeTsPackageJson({
          cwd,
          name,
          deps: ["zyndai"],
          entryFile: `service.${ext}`,
          runCommand: "zynd service run",
        });
        writeTsConfig(cwd);
        writeGitignore(cwd);
      }

      console.log();
      console.log(chalk.green(`Service "${name}" scaffolded (${LANGUAGE_LABELS[lang]}).`));
      console.log();
      console.log(`  ${chalk.dim("Language")}    ${LANGUAGE_LABELS[lang]}`);
      console.log(`  ${chalk.dim("Config")}      ${path.relative(cwd, configFilePath)}`);
      console.log(`  ${chalk.dim("Entry")}       service.${ext}`);
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
      const installCmd =
        lang === "ts"
          ? pkgWritten
            ? "npm install"
            : "npm install zyndai"
          : "pip install zyndai-agent";
      console.log(`    1. Install deps: ${chalk.cyan(installCmd)}`);
      console.log(`    2. Edit service.${ext}`);
      console.log(`    3. Run: ${chalk.cyan("zynd service run")}`);
    });

  service
    .command("run")
    .description("Start the service from the current directory (auto-detects TS or Python)")
    .option("--port <port>", "Override webhook port", parseInt)
    .action(async (opts: { port?: number }) => {
      const cwd = process.cwd();

      const newConfigPath = path.join(cwd, "service.config.json");
      const legacyConfigPath = path.join(cwd, ".service", "service.json");
      const configPath = fs.existsSync(newConfigPath)
        ? newConfigPath
        : fs.existsSync(legacyConfigPath)
          ? legacyConfigPath
          : null;

      if (!configPath) {
        console.error(
          chalk.red(
            "No service.config.json found in current directory. Run: zynd service init",
          ),
        );
        process.exitCode = 1;
        return;
      }

      const raw = JSON.parse(
        fs.readFileSync(configPath, "utf-8"),
      ) as Record<string, unknown>;
      const name = (raw["name"] as string) ?? "unnamed-service";
      const port = opts.port ?? (raw["webhook_port"] as number) ?? 5000;

      console.log(chalk.dim(`Starting service "${name}" on port ${port}...`));
      console.log();

      const declaredLang = raw["language"] as string | undefined;
      const tsEntries = ["service.ts", "service.js", "service.mjs", "service.cjs"];
      const pyEntries = ["service.py"];
      const entries =
        declaredLang === "py" ? [...pyEntries, ...tsEntries] : [...tsEntries, ...pyEntries];

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

      // Fallback: TS in-process echo.
      try {
        const { ZyndService } = await import("../service.js");
        const { ServiceConfigSchema } = await import("../types.js");
        const config = ServiceConfigSchema.parse({
          name,
          description: (raw["description"] as string) ?? "",
          category: (raw["category"] as string) ?? "general",
          tags: (raw["tags"] as string[]) ?? [],
          registryUrl:
            (raw["registry_url"] as string) ?? "https://dns01.zynd.ai",
          webhookPort: port,
        });
        const svc = new ZyndService(config);
        svc.setHandler((input: string) => `Service echo: ${input}`);
        await svc.start();
      } catch (err) {
        console.error(
          chalk.red(
            `Service failed to start: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
