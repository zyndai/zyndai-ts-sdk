import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const SERVICE = "zynd-bridge";
const ACCOUNT = "master-key";

function zynd_dir(): string {
  return process.env["ZYND_HOME"] ?? path.join(process.env["HOME"] ?? "~", ".zynd");
}

const KEY_FILE = path.join(zynd_dir(), ".bridge.master.key");

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function keychainRead(): Buffer | null {
  try {
    const hex = execFileSync("security", [
      "find-generic-password",
      "-a", ACCOUNT,
      "-s", SERVICE,
      "-w",
    ], { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
    if (hex.length !== 64) return null;
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

function keychainWrite(key: Buffer): void {
  const hex = key.toString("hex");
  // Delete any existing entry first to avoid ERR_SEC_DUPLICATE_ITEM
  try {
    execFileSync("security", [
      "delete-generic-password", "-a", ACCOUNT, "-s", SERVICE,
    ], { stdio: "pipe" });
  } catch {
    // Entry absent — fine
  }
  execFileSync("security", [
    "add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", hex,
  ], { stdio: "pipe" });
}

function fileRead(): Buffer | null {
  if (!fs.existsSync(KEY_FILE)) return null;
  const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

function fileWrite(key: Buffer): void {
  fs.mkdirSync(zynd_dir(), { recursive: true });
  // 0600: owner read/write only — no group/other access
  fs.writeFileSync(KEY_FILE, key.toString("hex"), { mode: 0o600 });
}

/**
 * Retrieve (or generate) the 32-byte AES-256 master key.
 * macOS: Keychain (hardware-backed when Secure Enclave present).
 * Linux/Windows: ~/.zynd/.bridge.master.key (0600 permissions).
 */
export async function getMasterKey(): Promise<Buffer> {
  if (isMacOS()) {
    const existing = keychainRead();
    if (existing) return existing;
    const key = crypto.randomBytes(32);
    keychainWrite(key);
    return key;
  }

  const existing = fileRead();
  if (existing) return existing;

  process.stderr.write(
    `[bridge] WARNING: macOS Keychain unavailable. Master key stored in ${KEY_FILE} — protect this file.\n`
  );
  const key = crypto.randomBytes(32);
  fileWrite(key);
  return key;
}

export async function deleteMasterKey(): Promise<void> {
  if (isMacOS()) {
    try {
      execFileSync("security", [
        "delete-generic-password", "-a", ACCOUNT, "-s", SERVICE,
      ], { stdio: "pipe" });
    } catch {
      // Already absent
    }
    return;
  }
  if (fs.existsSync(KEY_FILE)) fs.unlinkSync(KEY_FILE);
}
