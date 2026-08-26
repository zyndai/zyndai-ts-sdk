import type { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  loadCtxConfig,
  saveCtxConfig,
  ctxConfigPath,
  getMemoryUrl,
  getRegistryUrl,
  getAccessToken,
  getJwtSecret,
  getUserIdFromConfig,
  discoverMemoryLayer,
} from "../ctx/config.js";
import { MemoryClient } from "../ctx/memory-client.js";
import { oauthLogin } from "../ctx/oauth.js";
import { LinkedInConnector } from "../ctx/connectors/linkedin.js";
import { Mem0Connector } from "../ctx/connectors/mem0.js";
import { ZepConnector } from "../ctx/connectors/zep.js";
import { ZyndNativeConnector } from "../ctx/connectors/zynd-native.js";
import { sync, getMatches } from "../ctx/sync.js";
import type { ConnectorHealth, CtxConfig, IMemoryConnector } from "../ctx/types.js";
import { loadKeypairWithMetadata } from "../identity.js";
import { linkedInSessionExists, openLinkedInBrowserAuth, promptLinkedInBrowserAuth } from "./linkedin-setup.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getUserId(config: CtxConfig): string {
  const uid = getUserIdFromConfig(config);
  if (!uid) {
    console.error(chalk.red(
      '\nNo user ID configured. Run "zynd ctx init" to sign in.'
    ));
    process.exit(1);
  }
  return uid;
}

function buildMemoryClient(config: CtxConfig): MemoryClient {
  const accessToken = getAccessToken(config);
  const jwtSecret = getJwtSecret(config);
  const userId = getUserIdFromConfig(config);
  const memoryUrl = getMemoryUrl(config);

  return new MemoryClient({
    baseUrl: memoryUrl,
    accessToken: accessToken || undefined,
    refreshToken: config.refresh_token,
    oauthClientId: config.oauth_client_id,
    userId,
    jwtSecret: jwtSecret || undefined,
    onTokenRefresh: (newAccessToken, newRefreshToken) => {
      const saved = loadCtxConfig();
      saved.access_token = newAccessToken;
      saved.refresh_token = newRefreshToken;
      saveCtxConfig(saved);
    },
  });
}

function buildConnectors(config: CtxConfig, memClient: MemoryClient): IMemoryConnector[] {
  const connectors: IMemoryConnector[] = [];

  if (config.providers.linkedin?.li_at) {
    const li = new LinkedInConnector();
    li.connect({
      li_at: config.providers.linkedin.li_at,
      jsessionid: config.providers.linkedin.jsessionid ?? "",
    }).catch(() => {});
    connectors.push(li);
  }

  if (config.providers.mem0?.api_key) {
    const m = new Mem0Connector();
    m.connect({
      api_key: config.providers.mem0.api_key,
      user_id: config.providers.mem0.user_id ?? "default",
    }).catch(() => {});
    connectors.push(m);
  }

  if (config.providers.zep?.api_key) {
    const z = new ZepConnector();
    z.connect({
      url: config.providers.zep.url,
      api_key: config.providers.zep.api_key,
      user_id: config.providers.zep.user_id,
      session_id: config.providers.zep.session_id,
    }).catch(() => {});
    connectors.push(z);
  }

  const native = new ZyndNativeConnector();
  native.connect({ _memoryClient: memClient }).catch(() => {});
  connectors.push(native);

  return connectors;
}

export function registerCtxCommand(program: Command): void {
  const ctx = program
    .command("ctx")
    .description("Memory context sync — connect providers, enrich agent card, find matches");

  // zynd ctx init
  ctx
    .command("init")
    .description("Configure memory providers and connect to memory-layer")
    .action(async () => {
      const rl = readline.createInterface({ input, output });
      // Gracefully handle piped/closed stdin — return empty string (accept default)
      const ask = async (q: string): Promise<string> => {
        try {
          return await rl.question(q);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return "";
          throw err;
        }
      };

      console.log(chalk.bold("\nzynd ctx init — configure memory providers\n"));
      const existing = loadCtxConfig();
      const config: CtxConfig = { ...existing, providers: { ...existing.providers } };

      // ── Step 1: Ask ALL questions first (no async between questions) ───────
      console.log(chalk.bold("Memory layer\n"));
      const currentUrl = getMemoryUrl(config);
      const urlInput = await ask(`URL [${currentUrl}]: `);
      const memUrl = urlInput.trim() || currentUrl;

      console.log(chalk.bold("\nMemory providers\n"));

      // ── Phase 1: Collect ALL text answers — zero async between questions ──

      const linkedInAlreadyConfigured = linkedInSessionExists(config.providers.linkedin?.li_at);
      const linkedInDefault = linkedInAlreadyConfigured ? "Y/n" : "y/N";
      const linkedInAnswer = (await ask(`Add LinkedIn? (${linkedInDefault}) `)).trim().toLowerCase();
      const wantsLinkedIn = linkedInAlreadyConfigured ? linkedInAnswer !== "n" : linkedInAnswer === "y";

      let mem0Key = "", mem0Uid = "";
      const wantsMem0 = (await ask("Add mem0? (y/N) ")).toLowerCase() === "y";
      if (wantsMem0) {
        mem0Key = await ask("  mem0 API key: ");
        mem0Uid = await ask("  mem0 user ID [default]: ");
      }

      let zepUrl = "", zepKey = "", zepUid = "";
      const wantsZep = (await ask("Add Zep? (y/N) ")).toLowerCase() === "y";
      if (wantsZep) {
        zepUrl = await ask("  Zep URL [https://api.getzep.com]: ");
        zepKey = await ask("  Zep API key: ");
        zepUid = await ask("  Zep user ID [default]: ");
      }

      rl.close();

      // ── Phase 2: Apply config from collected answers ──────────────────────
      if (wantsMem0 && mem0Key.trim()) {
        config.providers.mem0 = {
          api_key: mem0Key.trim(),
          ...(mem0Uid.trim() ? { user_id: mem0Uid.trim() } : {}),
        };
      }
      if (wantsZep && zepKey.trim()) {
        config.providers.zep = {
          url: zepUrl.trim() || "https://api.getzep.com",
          api_key: zepKey.trim(),
          ...(zepUid.trim() ? { user_id: zepUid.trim() } : {}),
        };
      }

      // ── Phase 3: Async — memory-layer sign-in, LinkedIn auth ─────────────

      process.stdout.write("\nChecking memory-layer... ");
      const discovered = await discoverMemoryLayer(memUrl);
      if (!discovered) {
        console.log(chalk.yellow("could not reach — sync will fail until reachable"));
        if (urlInput.trim()) config.memory_url = urlInput.trim();
      } else {
        config.memory_url = discovered.url;
        console.log(chalk.green("reachable"));

        const alreadyAuthed = Boolean(config.access_token && config.user_id);
        if (alreadyAuthed) {
          console.log(chalk.green(`  ✓ Already signed in (user ${config.user_id!.slice(0, 8)}…)`));
        } else {
          console.log(chalk.dim("  Signing in with Google…"));
          try {
            const tokens = await oauthLogin(discovered.url);
            config.access_token = tokens.accessToken;
            config.refresh_token = tokens.refreshToken;
            config.oauth_client_id = tokens.clientId;
            config.user_id = tokens.userId;
            console.log(chalk.green(`  ✓ Signed in (user ${tokens.userId.slice(0, 8)}…)`));
          } catch (err) {
            console.log(chalk.red(`  Sign-in failed: ${err instanceof Error ? err.message : String(err)}`));
            console.log(chalk.dim("  Re-run: zynd ctx init"));
          }
        }
      }

      if (wantsLinkedIn) {
        if (linkedInAlreadyConfigured) {
          console.log(chalk.green("\n  ✓ LinkedIn session already active"));
        } else {
          console.log(chalk.dim("\n  Opening LinkedIn in your default browser — log in with any method..."));
          try {
            const auth = await openLinkedInBrowserAuth();
            config.providers.linkedin = { li_at: auth.li_at, jsessionid: auth.jsessionid };
            console.log(chalk.green("  ✓ LinkedIn authenticated"));
          } catch (err) {
            console.log(chalk.red(`  LinkedIn auth failed: ${err instanceof Error ? err.message : String(err)}`));
            console.log(chalk.dim("  Re-run: zynd ctx linkedin-auth"));
          }
        }
      }

      // ── Phase 4: Save ─────────────────────────────────────────────────────
      saveCtxConfig(config);
      console.log(chalk.green(`\nConfig saved → ${ctxConfigPath()}`));
      console.log(chalk.dim('Run "zynd ctx sync" to pull your context now.'));
      if (config.access_token) {
        console.log(chalk.dim('Then "zynd ctx mcp-setup" to wire ZYND into Claude Desktop.'));
      }
    });

  // zynd ctx sync
  ctx
    .command("sync")
    .description("Pull from all connected providers and update memory + agent card")
    .action(async () => {
      const config = loadCtxConfig();
      getUserId(config);
      const registryUrl = getRegistryUrl(config);

      const memClient = buildMemoryClient(config);
      const connectors = buildConnectors(config, memClient);

      if (connectors.length === 0) {
        console.log(chalk.yellow('No providers configured. Run "zynd ctx init" first.'));
        return;
      }

      console.log(chalk.bold(`Syncing ${connectors.length} provider(s)...`));

      let keypair;
      let agentId: string | undefined;
      try {
        const zyndhome = process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
        const keypairPath = path.join(zyndhome, "keypair.json");
        const [kp, meta] = loadKeypairWithMetadata(keypairPath);
        keypair = kp;
        agentId = (meta?.entityId as string | undefined) ?? (meta?.entity_id as string | undefined);
      } catch {
        // No keypair — skip card enrichment
      }

      const result = await sync({
        connectors,
        memoryClient: memClient,
        agentId,
        keypair,
        registryUrl,
      });

      console.log(chalk.green("\nSync complete:"));
      console.log(`  Text ingested:  ${result.textBytes} bytes`);
      console.log(`  Facts declared: ${result.factsDeclared}`);
      console.log(`  Facts skipped:  ${result.factsSkipped}`);
      console.log(`  Card updated:   ${result.cardUpdated ? chalk.green("yes") : chalk.dim("no")}`);

      if (Object.keys(result.connectorResults).length > 0) {
        console.log("\nConnectors:");
        let linkedInSkipped = false;
        for (const [name, res] of Object.entries(result.connectorResults)) {
          const icon = res.ok ? chalk.green("✓") : chalk.red("✗");
          const detail = res.error ? chalk.dim(` — ${res.error}`) : "";
          console.log(`  ${icon} ${name}${detail}`);
          if (name === "linkedin_mcp" && !res.ok) linkedInSkipped = true;
        }
        if (linkedInSkipped) {
          console.log(chalk.dim("\n  Authenticate LinkedIn: zynd ctx linkedin-auth"));
        }
      }

      // Auto-approve high-confidence inferred facts so they appear in matching.
      // The memory-layer's DeepSeek pipeline extracts assertions from ingested text
      // as private facts; without approval they never enter the public matching pool.
      try {
        const suggestions = await memClient.getSuggestions();
        const toApprove = suggestions.filter((s) => s.confidence >= 0.75);
        if (toApprove.length > 0) {
          let approved = 0;
          for (const s of toApprove) {
            try {
              await memClient.approveSuggestion(s.predicate, s.object);
              approved++;
            } catch {
              // Individual approval failure is non-fatal
            }
          }
          if (approved > 0) {
            console.log(chalk.dim(`\n  Auto-approved ${approved} inferred facts → now matchable`));
          }
        }
      } catch {
        // Suggestions endpoint optional — don't fail sync if unavailable
      }
    });

  // zynd ctx start
  ctx
    .command("start")
    .description("Run sync daemon (syncs on interval)")
    .option("--interval <ms>", "Sync interval in milliseconds", "3600000")
    .action(async (opts: { interval: string }) => {
      const intervalMs = Math.max(60_000, parseInt(opts.interval, 10) || 3_600_000);
      console.log(chalk.bold(`zynd ctx daemon started (interval: ${intervalMs / 1000}s)`));
      console.log(chalk.dim('Press Ctrl+C to stop.\n'));

      const runSync = async () => {
        const ts = new Date().toISOString();
        process.stdout.write(`[${ts}] Syncing... `);
        try {
          const config = loadCtxConfig();
          getUserId(config);
          const memClient = buildMemoryClient(config);
          const connectors = buildConnectors(config, memClient);
          const result = await sync({ connectors, memoryClient: memClient });
          console.log(
            chalk.green("ok") +
            chalk.dim(` (${result.factsDeclared} facts, ${result.textBytes}B text)`)
          );
        } catch (err) {
          console.log(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}`));
        }
      };

      await runSync();
      const timer = setInterval(runSync, intervalMs);
      process.on("SIGINT", () => {
        clearInterval(timer);
        console.log("\nDaemon stopped.");
        process.exit(0);
      });
      await new Promise<never>(() => {});
    });

  // zynd ctx status
  ctx
    .command("status")
    .description("Show provider health and current findability card")
    .action(async () => {
      const config = loadCtxConfig();
      getUserId(config);
      const memClient = buildMemoryClient(config);
      const connectors = buildConnectors(config, memClient);

      console.log(chalk.bold("\nProvider health:\n"));
      for (const connector of connectors) {
        const h = await connector.health().catch((err: unknown): ConnectorHealth => ({
          connected: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        const icon = h.connected ? chalk.green("✓") : chalk.red("✗");
        const extra = h.cooldownUntil
          ? chalk.yellow(` cooldown until ${h.cooldownUntil.toISOString()}`)
          : h.error
          ? chalk.dim(` ${h.error}`)
          : h.rateLimitRemaining !== undefined
          ? chalk.dim(` (${h.rateLimitRemaining}/hr remaining)`)
          : "";
        console.log(`  ${icon} ${connector.name}${extra}`);
      }

      try {
        const card = await memClient.getCard();
        if (card.length > 0) {
          console.log(chalk.bold("\nPublic findability card:\n"));
          for (const fact of card) {
            console.log(`  ${chalk.cyan(fact.predicate)} → ${fact.object} (${fact.confidence.toFixed(2)})`);
          }
        } else {
          console.log(chalk.dim("\nNo public facts yet. Run zynd ctx sync."));
        }
      } catch (err) {
        console.log(chalk.red(`\nCould not fetch card: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // zynd ctx match
  ctx
    .command("match")
    .description("Find similar people via HNSW cosine matching")
    .option("--cluster <type>", "Cluster to match on (full_context|skill_cluster|intent_cluster|place_cluster)", "full_context")
    .option("--limit <n>", "Max results", "10")
    .action(async (opts: { cluster: string; limit: string }) => {
      const config = loadCtxConfig();
      getUserId(config);
      const memClient = buildMemoryClient(config);

      const cluster = (opts.cluster as "full_context") ?? "full_context";
      const limit = Math.min(50, parseInt(opts.limit, 10) || 10);

      console.log(chalk.bold(`\nTop ${limit} matches (${cluster}):\n`));
      try {
        const matches = await getMatches(memClient, getRegistryUrl(config), cluster, limit);
        if (matches.length === 0) {
          console.log(chalk.dim("No matches yet — need at least 5 public assertions to match."));
          return;
        }
        for (const [i, m] of matches.entries()) {
          const pct = Math.round(m.similarity * 100);
          console.log(`  ${i + 1}. ${chalk.bold(m.display_name)} ${chalk.dim(`(${pct}% similar)`)}`);
          if (m.contact) console.log(`     ${chalk.dim(m.contact)}`);
        }
      } catch (err) {
        console.log(chalk.red(`Match failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // zynd ctx linkedin-auth
  ctx
    .command("linkedin-auth")
    .description("Re-authenticate LinkedIn via browser (works with Google OAuth, SSO, email)")
    .action(async () => {
      console.log(chalk.dim("Opening LinkedIn in your default browser — log in with any method..."));
      try {
        const auth = await promptLinkedInBrowserAuth();
        const config = loadCtxConfig();
        config.providers.linkedin = { li_at: auth.li_at, jsessionid: auth.jsessionid };
        saveCtxConfig(config);
        console.log(chalk.green("✓ LinkedIn authenticated — run: zynd ctx sync"));
      } catch (err) {
        console.log(chalk.red(`failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // zynd ctx mcp-setup
  ctx
    .command("mcp-setup")
    .description("Wire ZYND memory into Claude Desktop (or any MCP client)")
    .option("--print", "Print the config block only — don't write any files")
    .option("--client <name>", "Target client: claude|cursor|windsurf|vscode", "claude")
    .action(async (opts: { print?: boolean; client: string }) => {
      const config = loadCtxConfig();
      const token = getAccessToken(config);
      if (!token) {
        console.error(chalk.red("Not signed in. Run: zynd ctx init"));
        process.exit(1);
      }

      const mcpBlock = {
        zynd: {
          command: "npx",
          args: [
            "-y", "mcp-remote",
            "https://api.zynd.ai/mcp",
            "--header", `Authorization: Bearer ${token}`,
          ],
        },
      };

      if (opts.print) {
        console.log(JSON.stringify({ mcpServers: mcpBlock }, null, 2));
        return;
      }

      // Target config paths per client
      const configPaths: Record<string, string> = {
        claude: path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
        cursor: path.join(os.homedir(), ".cursor/mcp.json"),
        windsurf: path.join(os.homedir(), ".codeium/windsurf/mcp_config.json"),
        vscode: path.join(os.homedir(), ".vscode/mcp.json"),
      };

      const targetPath = configPaths[opts.client];
      if (!targetPath) {
        console.error(chalk.red(`Unknown client "${opts.client}". Use: claude, cursor, windsurf, vscode`));
        process.exit(1);
      }

      // Merge into existing config (never clobber other entries)
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(targetPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(targetPath, "utf8")) as Record<string, unknown>;
        } catch {
          // Unreadable config — start fresh
        }
      }

      const existingServers = (existing["mcpServers"] as Record<string, unknown> | undefined) ?? {};
      const merged = { ...existing, mcpServers: { ...existingServers, ...mcpBlock } };

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2));

      console.log(chalk.green(`✓ ZYND memory wired into ${opts.client === "claude" ? "Claude Desktop" : opts.client}`));
      console.log(chalk.dim(`  Config: ${targetPath}`));
      console.log(chalk.bold("\nRestart your AI client. Then try: \"What do you know about me?\"\n"));
      console.log(chalk.dim("  Your Claude will call get_my_context() automatically and know:"));
      console.log(chalk.dim("    • Your LinkedIn profile + connections"));
      console.log(chalk.dim("    • Skills, projects, location from all synced sources"));
      console.log(chalk.dim("    • Who you should connect with (find_similar_users)"));
    });

  // zynd ctx card
  ctx
    .command("card")
    .description("Show your public findability card")
    .action(async () => {
      const config = loadCtxConfig();
      getUserId(config);
      const memClient = buildMemoryClient(config);

      try {
        const card = await memClient.getCard();
        if (card.length === 0) {
          console.log(chalk.dim('No public facts yet. Run "zynd ctx sync" first.'));
          return;
        }
        console.log(chalk.bold("\nYour public findability card:\n"));
        for (const fact of card) {
          console.log(`  ${chalk.cyan(fact.predicate.padEnd(24))} ${fact.object}`);
        }
      } catch (err) {
        console.log(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
