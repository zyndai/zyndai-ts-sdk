import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getMasterKey } from "./keychain.js";
import type { TieredAssertion } from "./distiller.js";

function zynd_dir(): string {
  return process.env["ZYND_HOME"] ?? path.join(process.env["HOME"] ?? "~", ".zynd");
}

const STORE_FILE = path.join(zynd_dir(), "bridge.enc.json");
const STORE_TMP = STORE_FILE + ".tmp";

export interface LinkedInGovernorState {
  windowStart: number;
  hourCount: number;
  dayWindowStart: number;
  dayCount: number;
  cooldownUntil: number | null;
}

export interface OutboxItem {
  id: string;
  predicate: string;
  object: string;
  tier: 0 | 1 | 2;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

export interface LocalMemory {
  id: string;
  content: string;
  createdAt: number;
}

export interface BridgeStore {
  version: number;
  linkedin: LinkedInGovernorState;
  assertions: TieredAssertion[];
  outbox: OutboxItem[];
  localMemories: LocalMemory[];
}

const EMPTY_STORE: BridgeStore = {
  version: 1,
  linkedin: {
    windowStart: 0,
    hourCount: 0,
    dayWindowStart: 0,
    dayCount: 0,
    cooldownUntil: null,
  },
  assertions: [],
  outbox: [],
  localMemories: [],
};

// ─── AES-256-GCM helpers ─────────────────────────────────────────────────────

interface EncryptedEnvelope {
  iv: string;   // 12-byte nonce, hex
  tag: string;  // 16-byte GCM auth tag, hex
  data: string; // ciphertext, hex
}

function encrypt(plaintext: string, key: Buffer): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(envelope: EncryptedEnvelope, key: Buffer): string {
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.data, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  } catch {
    throw new Error("ERR_CIPHERTEXT_TAMPERED: store decryption failed — data may be corrupt or key mismatch");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadStore(): Promise<BridgeStore> {
  const key = await getMasterKey();

  if (!fs.existsSync(STORE_FILE)) {
    return { ...EMPTY_STORE, linkedin: { ...EMPTY_STORE.linkedin } };
  }

  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    const plaintext = decrypt(envelope, key);
    const parsed = JSON.parse(plaintext) as BridgeStore;
    return { ...EMPTY_STORE, ...parsed };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("ERR_CIPHERTEXT_TAMPERED")) throw err;
    throw new Error(
      `bridge store load error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

export async function saveStore(store: BridgeStore): Promise<void> {
  const key = await getMasterKey();
  const plaintext = JSON.stringify(store);
  const envelope = encrypt(plaintext, key);

  fs.mkdirSync(zynd_dir(), { recursive: true });
  // Atomic write: write to .tmp then rename — prevents partial writes on crash
  fs.writeFileSync(STORE_TMP, JSON.stringify(envelope), { mode: 0o600 });
  fs.renameSync(STORE_TMP, STORE_FILE);
}

export async function withStore<T>(
  fn: (store: BridgeStore) => Promise<T> | T
): Promise<T> {
  const store = await loadStore();
  const result = await fn(store);
  await saveStore(store);
  return result;
}
