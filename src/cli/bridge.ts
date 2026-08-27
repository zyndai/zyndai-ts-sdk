import type { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  loadBridgeConfig,
  saveBridgeConfig,
  bridgeConfigPath,
  getMemoryUrl,
  getRegistryUrl,
  getAccessToken,
  getJwtSecret,
  getUserIdFromConfig,
  discoverMemoryLayer,
} from "../bridge/config.js";
import { MemoryClient } from "../bridge/memory-client.js";
import { oauthLogin } from "../bridge/oauth.js";
import { LinkedInConnector } from "../bridge/connectors/linkedin.js";
import { Mem0Connector } from "../bridge/connectors/mem0.js";
import { ZepConnector } from "../bridge/connectors/zep.js";
import { ZyndNativeConnector } from "../bridge/connectors/zynd-native.js";
import { sync, getMatches } from "../bridge/sync.js";
import type { ConnectorHealth, BridgeConfig, IMemoryConnector } from "../bridge/types.js";
import { loadKeypairWithMetadata } from "../identity.js";
import { linkedInSessionExists, openLinkedInBrowserAuth, promptLinkedInBrowserAuth } from "./linkedin-setup.js";
import { acquireLock, registerShutdownHandlers, isDaemonRunning, getDaemonPid } from "../bridge/daemon.js";
import { startMcpServer } from "../bridge/mcp-server.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getUserId(config: BridgeConfig): string {
  const uid = getUserIdFromConfig(config);
  if (!uid) {
    console.error(chalk.red('\nNo user ID configured. Run "zynd bridge init" to sign in.'));
    process.exit(1);
  }
  return uid;
}

function buildMemoryClient(config: BridgeConfig): MemoryClient {
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
      const saved = loadBridgeConfig();
      saved.access_token = newAccessToken;
      saved.refresh_token = newRefreshToken;
      saveBridgeConfig(saved);
    },
  });
}

function buildConnectors(config: BridgeConfig, memClient: MemoryClient): IMemoryConnector[] {
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

export function registerBridgeCommand(program: Command): void {
  const bridge = program
    .command("bridge")
    .description("Local-first personal memory sync — pull LinkedIn, enrich context, find matches");

  // zynd bridge init
  bridge
    .command("init")
    .description("Configure memory providers and connect to memory-layer")
    .option("--memory-url <url>", "Memory-layer URL override (default: https://api.zynd.ai)")
    .action(async (opts: { memoryUrl?: string }) => {
      const rl = readline.createInterface({ input, output });
      const ask = async (q: string): Promise<string> => {
        try {
          return await rl.question(q);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return "";
          throw err;
        }
      };

      console.log(chalk.bold("\nzynd bridge init — configure memory providers\n"));
      const existing = loadBridgeConfig();
      const config: BridgeConfig = { ...existing, providers: { ...existing.providers } };

      const memUrl = opts.memoryUrl?.trim() || getMemoryUrl(config);
      console.log(chalk.dim(`Memory layer: ${memUrl}`));

      console.log(chalk.bold("\nMemory providers\n"));

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

      process.stdout.write("\nChecking memory-layer... ");
      const discovered = await discoverMemoryLayer(memUrl);
      if (!discovered) {
        console.log(chalk.yellow("could not reach — sync will fail until reachable"));
        if (opts.memoryUrl?.trim()) config.memory_url = opts.memoryUrl.trim();
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
            console.log(chalk.dim("  Re-run: zynd bridge init"));
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
            console.log(chalk.dim("  Re-run: zynd bridge linkedin-auth"));
          }
        }
      }

      saveBridgeConfig(config);
      console.log(chalk.green(`\nConfig saved → ${bridgeConfigPath()}`));
      console.log(chalk.dim('Run "zynd bridge sync" to pull your context now.'));
      if (config.access_token) {
        console.log(chalk.dim('Then "zynd bridge mcp-setup" to wire ZYND into Claude Desktop.'));
      }
    });

  // zynd bridge sync
  bridge
    .command("sync")
    .description("Pull from all connected providers and update memory + agent card")
    .action(async () => {
      const config = loadBridgeConfig();
      getUserId(config);
      const registryUrl = getRegistryUrl(config);

      const memClient = buildMemoryClient(config);
      const connectors = buildConnectors(config, memClient);

      if (connectors.length === 0) {
        console.log(chalk.yellow('No providers configured. Run "zynd bridge init" first.'));
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
          if (name === "linkedin" && !res.ok) linkedInSkipped = true;
        }
        if (linkedInSkipped) {
          console.log(chalk.dim("\n  Authenticate LinkedIn: zynd bridge linkedin-auth"));
        }
      }

      // Auto-approve high-confidence inferred facts so they enter matching pool
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

  // zynd bridge start
  bridge
    .command("start")
    .description("Run sync daemon (syncs on interval)")
    .option("--interval <ms>", "Sync interval in milliseconds", "3600000")
    .action(async (opts: { interval: string }) => {
      try {
        acquireLock();
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const intervalMs = Math.max(60_000, parseInt(opts.interval, 10) || 3_600_000);
      console.log(chalk.bold(`zynd bridge daemon started (interval: ${intervalMs / 1000}s)`));
      console.log(chalk.dim("Press Ctrl+C to stop.\n"));

      const runSync = async () => {
        const ts = new Date().toISOString();
        process.stdout.write(`[${ts}] Syncing... `);
        try {
          const config = loadBridgeConfig();
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

      let timer: ReturnType<typeof setInterval>;
      registerShutdownHandlers(() => {
        clearInterval(timer);
        console.log("Daemon stopped.");
      });

      await runSync();
      timer = setInterval(runSync, intervalMs);
      await new Promise<never>(() => {});
    });

  // zynd bridge stop
  bridge
    .command("stop")
    .description("Stop a running sync daemon")
    .action(() => {
      const pid = getDaemonPid();
      if (!pid || !isDaemonRunning()) {
        console.log(chalk.dim("No bridge daemon running."));
        return;
      }
      process.kill(pid, "SIGTERM");
      console.log(chalk.green(`Sent SIGTERM to daemon (PID ${pid}).`));
    });

  // zynd bridge status
  bridge
    .command("status")
    .description("Show provider health and current findability card")
    .action(async () => {
      const config = loadBridgeConfig();
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
          console.log(chalk.dim('\nNo public facts yet. Run "zynd bridge sync".'));
        }
      } catch (err) {
        console.log(chalk.red(`\nCould not fetch card: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // zynd bridge match
  bridge
    .command("match")
    .description("Find similar people via HNSW cosine matching")
    .option(
      "--cluster <type>",
      "Cluster type: full_context|skill_cluster|intent_cluster|place_cluster",
      "full_context"
    )
    .option("--limit <n>", "Max results", "10")
    .action(async (opts: { cluster: string; limit: string }) => {
      const config = loadBridgeConfig();
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

  // zynd bridge seed
  bridge
    .command("seed")
    .description("Declare a demo persona of public findability facts so match can be tested")
    .action(async () => {
      const config = loadBridgeConfig();
      getUserId(config);
      const memClient = buildMemoryClient(config);

      // Demo persona — uses the memory-layer's declarable findability predicates.
      // has_expertise_in / is_building / is_learning / is_located_in / is_affiliated_with
      // are free-form; open_to / is_seeking are enum-valued (see memory-layer OpenAPI).
      const demoFacts: Array<{ predicate: string; value: string }> = [
        { predicate: "has_expertise_in", value: "TypeScript" },
        { predicate: "has_expertise_in", value: "Rust" },
        { predicate: "has_expertise_in", value: "React" },
        { predicate: "is_building", value: "Local-first AI agent infrastructure" },
        { predicate: "is_learning", value: "Rust systems programming" },
        { predicate: "is_seeking", value: "peer_review" },
        { predicate: "open_to", value: "collaboration" },
        { predicate: "is_located_in", value: "San Francisco, California" },
        { predicate: "is_affiliated_with", value: "Zynd AI" },
      ];

      // Idempotent: skip facts already on the public card so re-runs don't duplicate.
      let existing = new Set<string>();
      try {
        const card = await memClient.getCard();
        existing = new Set(card.map((f) => `${f.predicate}::${f.object}`));
      } catch {
        // Card fetch optional — fall through to declaring everything.
      }
      const toDeclare = demoFacts.filter((f) => !existing.has(`${f.predicate}::${f.value}`));

      if (toDeclare.length === 0) {
        console.log(chalk.dim('\nAll demo facts already declared. Run "zynd bridge card" to review.'));
        return;
      }

      console.log(chalk.bold(`\nDeclaring ${toDeclare.length} demo facts to memory-layer…\n`));
      try {
        const result = await memClient.declareBatch(toDeclare);
        console.log(chalk.green(`  ✓ Declared: ${result.declared.length}`));
        if (result.skipped.length > 0) {
          console.log(chalk.yellow(`  Skipped: ${result.skipped.length}`));
          for (const s of result.skipped) {
            console.log(chalk.dim(`    - ${s.predicate} → ${s.value}${s.reason ? ` (${s.reason})` : ""}`));
          }
        }
        console.log(
          chalk.dim('\nNext: "zynd bridge card" → your public card. "zynd bridge match" → similar people.')
        );
      } catch (err) {
        console.log(chalk.red(`Seed failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // zynd bridge linkedin-auth
  bridge
    .command("linkedin-auth")
    .description("Re-authenticate LinkedIn via browser (Google OAuth, SSO, email — any method)")
    .action(async () => {
      console.log(chalk.dim("Opening LinkedIn in your browser — log in with any method..."));
      try {
        const auth = await promptLinkedInBrowserAuth();
        const config = loadBridgeConfig();
        config.providers.linkedin = { li_at: auth.li_at, jsessionid: auth.jsessionid };
        saveBridgeConfig(config);
        console.log(chalk.green("✓ LinkedIn authenticated — run: zynd bridge sync"));
      } catch (err) {
        console.log(chalk.red(`failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // zynd bridge linkedin-search <keywords>  (PRD: search_people, gated)
  bridge
    .command("linkedin-search <keywords>")
    .description("Search LinkedIn people by keyword (gated — rate-limited, max 25 results)")
    .option("--depth <depth>", "Network depth: F=1st, S=2nd, O=other", "F")
    .option("--limit <n>", "Max results (capped at 25)", "10")
    .action(async (keywords: string, opts: { depth: string; limit: string }) => {
      const config = loadBridgeConfig();
      const li = config.providers.linkedin;
      if (!li?.li_at) {
        console.error(chalk.red("LinkedIn not authenticated — run: zynd bridge linkedin-auth"));
        process.exit(1);
      }
      const connector = new LinkedInConnector();
      await connector.connect({ li_at: li.li_at, jsessionid: li.jsessionid ?? "" });
      console.log(chalk.dim(`Searching LinkedIn for "${keywords}"…`));
      try {
        const results = await connector.searchPeople({
          keywords,
          depth: (opts.depth as "F" | "S" | "O") ?? "F",
          limit: Math.min(parseInt(opts.limit, 10) || 10, 25),
        });
        if (results.length === 0) {
          console.log(chalk.yellow("No results."));
          return;
        }
        for (const p of results) {
          console.log(`\n${chalk.bold(p.name)}  ${chalk.dim(p.url)}`);
          if (p.headline) console.log(`  ${p.headline}`);
          if (p.location) console.log(`  ${chalk.dim(p.location)}`);
        }
        console.log(chalk.dim(`\n${results.length} result(s)`));
      } catch (err) {
        console.error(chalk.red(`Search failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // zynd bridge linkedin-person <public-id>  (PRD: get_person_profile, gated)
  bridge
    .command("linkedin-person <public-id>")
    .description("Fetch a LinkedIn person profile by public ID (e.g. sahilw) — gated, rate-limited")
    .action(async (publicId: string) => {
      const config = loadBridgeConfig();
      const li = config.providers.linkedin;
      if (!li?.li_at) {
        console.error(chalk.red("LinkedIn not authenticated — run: zynd bridge linkedin-auth"));
        process.exit(1);
      }
      const connector = new LinkedInConnector();
      await connector.connect({ li_at: li.li_at, jsessionid: li.jsessionid ?? "" });
      console.log(chalk.dim(`Fetching profile: ${publicId}…`));
      try {
        const p = await connector.getPersonProfile(publicId);
        console.log(`\n${chalk.bold(`${p.name}`)}  ${chalk.dim(p.url)}`);
        if (p.headline) console.log(`  ${p.headline}`);
        if (p.location) console.log(`  ${chalk.dim(p.location)}`);
        if (p.experience?.length) {
          console.log(chalk.bold("\n  Experience:"));
          for (const e of p.experience.slice(0, 5)) {
            console.log(`    ${e.title} @ ${e.company}`);
          }
        }
        if (p.skills?.length) {
          console.log(chalk.bold("\n  Skills:") + "  " + p.skills.slice(0, 10).join(", "));
        }
      } catch (err) {
        console.error(chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // zynd bridge linkedin-company <public-id>  (PRD: get_company_profile, gated)
  bridge
    .command("linkedin-company <public-id>")
    .description("Fetch a LinkedIn company profile by public ID (e.g. openai) — gated, rate-limited")
    .action(async (publicId: string) => {
      const config = loadBridgeConfig();
      const li = config.providers.linkedin;
      if (!li?.li_at) {
        console.error(chalk.red("LinkedIn not authenticated — run: zynd bridge linkedin-auth"));
        process.exit(1);
      }
      const connector = new LinkedInConnector();
      await connector.connect({ li_at: li.li_at, jsessionid: li.jsessionid ?? "" });
      console.log(chalk.dim(`Fetching company: ${publicId}…`));
      try {
        const c = await connector.getCompanyProfile(publicId);
        console.log(`\n${chalk.bold(c.name)}  ${chalk.dim(c.url)}`);
        if (c.industry) console.log(`  Industry: ${c.industry}`);
        if (c.headcount) console.log(`  Headcount: ~${c.headcount}`);
        if (c.description) console.log(`  ${chalk.dim(c.description.slice(0, 200))}`);
        if (c.specialities?.length) {
          console.log("  Specialities: " + c.specialities.join(", "));
        }
        if (c.website) console.log(`  ${chalk.dim(c.website)}`);
      } catch (err) {
        console.error(chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // zynd bridge mcp-setup
  bridge
    .command("mcp-setup")
    .description("Wire ZYND memory into Claude Desktop (or any MCP client)")
    .option("--print", "Print the config block only — don't write any files")
    .option("--client <name>", "Target client: claude|cursor|windsurf|vscode", "claude")
    .action(async (opts: { print?: boolean; client: string }) => {
      const config = loadBridgeConfig();
      const token = getAccessToken(config);
      if (!token) {
        console.error(chalk.red("Not signed in. Run: zynd bridge init"));
        process.exit(1);
      }

      const mcpBlock = {
        zynd: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            "https://api.zynd.ai/mcp",
            "--header",
            `Authorization: Bearer ${token}`,
          ],
        },
      };

      if (opts.print) {
        console.log(JSON.stringify({ mcpServers: mcpBlock }, null, 2));
        return;
      }

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

      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      // 0o600: owner-only — file contains Bearer token
      fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      fs.chmodSync(targetPath, 0o600);

      console.log(
        chalk.green(`✓ ZYND memory wired into ${opts.client === "claude" ? "Claude Desktop" : opts.client}`)
      );
      console.log(chalk.dim(`  Config: ${targetPath}`));
      console.log(chalk.bold('\nRestart your AI client. Then try: "What do you know about me?"\n'));
      console.log(chalk.dim("  Your Claude will call get_my_context() automatically and know:"));
      console.log(chalk.dim("    • Your LinkedIn profile + connections"));
      console.log(chalk.dim("    • Skills, projects, location from all synced sources"));
      console.log(chalk.dim("    • Who you should connect with (find_similar_users)"));
    });

  // zynd bridge card
  bridge
    .command("card")
    .description("Show your public findability card")
    .action(async () => {
      const config = loadBridgeConfig();
      getUserId(config);
      const memClient = buildMemoryClient(config);

      try {
        const card = await memClient.getCard();
        if (card.length === 0) {
          console.log(chalk.dim('No public facts yet. Run "zynd bridge sync" first.'));
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

  // zynd bridge mcp-local
  bridge
    .command("mcp-local")
    .description("Start a local MCP server on loopback (127.0.0.1) and print the Claude Desktop config block")
    .option("--port <n>", "Port to listen on (default: OS-assigned)", "0")
    .option("--print", "Print config block only — don't start server")
    .action(async (opts: { port: string; print?: boolean }) => {
      const config = loadBridgeConfig();
      const token = getAccessToken(config);
      const memoryUrl = getMemoryUrl(config);

      if (opts.print) {
        console.log(chalk.bold("\nAdd to Claude Desktop mcpServers:\n"));
        console.log(JSON.stringify({
          "zynd-local": {
            command: "zynd",
            args: ["bridge", "mcp-local"],
          },
        }, null, 2));
        return;
      }

      const server = await startMcpServer({
        port: parseInt(opts.port, 10) || 0,
        memoryUrl,
        authToken: token || undefined,
      });

      console.log(chalk.green(`✓ Local MCP server listening on http://127.0.0.1:${server.port}`));
      console.log(chalk.dim(`  Bearer token: ${server.token}`));
      console.log(chalk.bold("\nAvailable tools:"));
      console.log(chalk.dim("  zynd_bridge_status, zynd_persona_preview, zynd_context_sync"));
      console.log(chalk.dim("  zynd_linkedin_status, zynd_match_search, zynd_remember"));
      console.log(chalk.dim("\nPress Ctrl+C to stop."));

      config.memory_url = config.memory_url ?? memoryUrl;
      config.local_mcp_port = server.port;
      config.local_mcp_token = server.token;
      saveBridgeConfig(config);

      registerShutdownHandlers(async () => {
        await server.stop();
        console.log("Local MCP server stopped.");
      });

      await new Promise<never>(() => {});
    });
}

// Backward-compat alias — src/cli/index.ts can import either name
export { registerBridgeCommand as registerCtxCommand };
