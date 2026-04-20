import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { keypairFromPrivateBytes, saveKeypair, loadKeypair, generateDeveloperId } from "../identity.js";
import { getRegistryUrl, ensureZyndDir, developerKeyPath, saveCliConfig } from "./config.js";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Authentication commands");

  auth
    .command("login")
    .description("Register via browser-based onboarding")
    .option("--name <name>", "Developer display name")
    .option("--force", "Overwrite existing developer keypair")
    .action(async (opts: { name?: string; force?: boolean }) => {
      ensureZyndDir();
      const keyPath = developerKeyPath();

      if (fs.existsSync(keyPath) && !opts.force) {
        console.log(`Developer keypair already exists at ${keyPath}`);
        console.log("Use --force to overwrite.");
        return;
      }

      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      console.log(`Contacting registry at ${registryUrl}...`);
      let info: Record<string, unknown>;
      try {
        const resp = await fetch(`${registryUrl}/v1/info`, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        info = await resp.json() as Record<string, unknown>;
      } catch (e) {
        console.error(chalk.red(`Failed to reach registry: ${e}`));
        process.exitCode = 1;
        return;
      }

      const onboarding = (info.developer_onboarding ?? {}) as Record<string, string>;
      const mode = onboarding.mode ?? "open";
      const authUrl = onboarding.auth_url ?? "";

      if (mode !== "restricted" || !authUrl) {
        console.log("This registry uses open onboarding. Use 'zynd init' instead.");
        return;
      }

      const state = crypto.randomBytes(32).toString("base64url");

      const result: Record<string, string> = {};
      const done = new Promise<void>((resolve) => {
        const server = http.createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://127.0.0.1`);
          if (url.pathname !== "/callback") {
            res.writeHead(404);
            res.end();
            return;
          }

          if (url.searchParams.get("state") !== state) {
            res.writeHead(400);
            res.end("State mismatch. Please try again.");
            return;
          }

          result.developer_id = url.searchParams.get("developer_id") ?? "";
          result.private_key_enc = url.searchParams.get("private_key_enc") ?? "";

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Authentication complete!</h2>" +
            "<p>You can close this tab and return to the terminal.</p>" +
            "</body></html>"
          );

          server.close();
          resolve();
        });

        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const callbackPort = typeof addr === "object" ? addr!.port : 0;

          const params = new URLSearchParams({
            callback_port: String(callbackPort),
            state,
            registry_url: registryUrl,
          });
          if (opts.name) params.set("name", opts.name);

          const browserUrl = `${authUrl}?${params}`;
          console.log("Opening browser for authentication...");
          console.log(`  ${browserUrl}`);

          const cmd = process.platform === "darwin" ? "open" :
                      process.platform === "win32" ? "start" : "xdg-open";
          execFile(cmd, [browserUrl], () => {});

          console.log("Waiting for authentication to complete...");
        });

        setTimeout(() => { server.close(); resolve(); }, 300_000);
      });

      await done;

      if (!result.developer_id || !result.private_key_enc) {
        console.error(chalk.red("Error: incomplete callback data received."));
        process.exitCode = 1;
        return;
      }

      let privateKeyB64: string;
      try {
        privateKeyB64 = decryptPrivateKey(result.private_key_enc, state);
      } catch (e) {
        console.error(chalk.red(`Failed to decrypt private key: ${e}`));
        process.exitCode = 1;
        return;
      }

      let privateBytes = Buffer.from(privateKeyB64, "base64");
      if (privateBytes.length === 64) privateBytes = privateBytes.subarray(0, 32);

      const kp = keypairFromPrivateBytes(new Uint8Array(privateBytes));
      saveKeypair(kp, keyPath);
      saveCliConfig({ registry_url: registryUrl });

      console.log();
      console.log("Authenticated successfully!");
      console.log(`  Developer ID: ${result.developer_id}`);
      console.log(`  Public key:   ${kp.publicKeyString}`);
      console.log(`  Saved to:     ${keyPath}`);
      console.log();
      console.log("You can now register agents with: zynd register");
    });

  auth
    .command("whoami")
    .description("Show current identity")
    .action(() => {
      const keyPath = developerKeyPath();
      if (!fs.existsSync(keyPath)) {
        console.log("No developer identity found. Run 'zynd auth login' or 'zynd init'.");
        return;
      }
      const kp = loadKeypair(keyPath);
      const devId = generateDeveloperId(kp.publicKeyBytes);
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);

      console.log(`  Developer ID: ${devId}`);
      console.log(`  Public key:   ${kp.publicKeyString}`);
      console.log(`  Registry:     ${registryUrl}`);
      console.log(`  Keypair:      ${keyPath}`);
    });
}

function decryptPrivateKey(ciphertextB64: string, state: string): string {
  const key = crypto.createHash("sha256").update(state).digest();
  const raw = Buffer.from(ciphertextB64, "base64");
  if (raw.length < 12) throw new Error("ciphertext too short");

  const nonce = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  const tagStart = ciphertext.length - 16;
  decipher.setAuthTag(ciphertext.subarray(tagStart));
  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, tagStart)),
    decipher.final(),
  ]);

  return plaintext.toString("utf-8");
}
