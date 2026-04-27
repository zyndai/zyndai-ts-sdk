import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex } from "@noble/hashes/utils";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the developer keypair path. Order:
 *   1. ZYND_DEVELOPER_KEYPAIR_PATH env var
 *   2. ZYND_HOME/developer.json
 *   3. ~/.zynd/developer.json
 */
export function defaultDeveloperKeyPath(): string {
  const envPath = process.env["ZYND_DEVELOPER_KEYPAIR_PATH"];
  if (envPath) return envPath;
  const home = process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
  return path.join(home, "developer.json");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export class Ed25519Keypair {
  readonly privateKeyBytes: Uint8Array;
  readonly publicKeyBytes: Uint8Array;

  constructor(privateKeyBytes: Uint8Array) {
    this.privateKeyBytes = privateKeyBytes;
    this.publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  }

  get privateKeyB64(): string {
    return toBase64(this.privateKeyBytes);
  }

  get publicKeyB64(): string {
    return toBase64(this.publicKeyBytes);
  }

  get publicKeyString(): string {
    return `ed25519:${this.publicKeyB64}`;
  }

  get entityId(): string {
    return generateEntityId(this.publicKeyBytes, "agent");
  }
}

export function generateKeypair(): Ed25519Keypair {
  const privateKey = ed25519.utils.randomPrivateKey();
  return new Ed25519Keypair(privateKey);
}

export function keypairFromPrivateBytes(privateBytes: Uint8Array): Ed25519Keypair {
  return new Ed25519Keypair(privateBytes);
}

export function loadKeypair(path: string): Ed25519Keypair {
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));
  const privateBytes = fromBase64(data.private_key);
  return keypairFromPrivateBytes(privateBytes);
}

export function loadKeypairWithMetadata(path: string): [Ed25519Keypair, Record<string, unknown> | null] {
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));
  const privateBytes = fromBase64(data.private_key);
  const kp = keypairFromPrivateBytes(privateBytes);
  return [kp, data.derived_from ?? null];
}

export function saveKeypair(kp: Ed25519Keypair, filePath: string, derivationMetadata?: Record<string, unknown>): void {
  const data: Record<string, unknown> = {
    public_key: kp.publicKeyB64,
    private_key: kp.privateKeyB64,
  };
  if (derivationMetadata) {
    data.derived_from = derivationMetadata;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function generateEntityId(publicKeyBytes: Uint8Array, entityType: string = "agent"): string {
  const digest = sha256(publicKeyBytes);
  const suffix = bytesToHex(digest.slice(0, 16));
  if (entityType === "service") return `zns:svc:${suffix}`;
  return `zns:${suffix}`;
}

export function generateDeveloperId(publicKeyBytes: Uint8Array): string {
  const digest = sha256(publicKeyBytes);
  return `zns:dev:${bytesToHex(digest.slice(0, 16))}`;
}

export function sign(privateKeyBytes: Uint8Array, message: Uint8Array): string {
  const sig = ed25519.sign(message, privateKeyBytes);
  return `ed25519:${toBase64(sig)}`;
}

export function verify(publicKeyB64: string, message: Uint8Array, signature: string): boolean {
  try {
    if (!signature.startsWith("ed25519:")) return false;
    const sigB64 = signature.slice("ed25519:".length);
    const sigBytes = fromBase64(sigB64);
    const pubBytes = fromBase64(publicKeyB64);
    return ed25519.verify(sigBytes, message, pubBytes);
  } catch {
    return false;
  }
}

export function deriveAgentKeypair(devPrivateKeyBytes: Uint8Array, index: number): Ed25519Keypair {
  const prefix = new TextEncoder().encode("zns:agent:");
  const indexBuf = new Uint8Array(4);
  new DataView(indexBuf.buffer).setUint32(0, index, false);
  const input = new Uint8Array(devPrivateKeyBytes.length + prefix.length + 4);
  input.set(devPrivateKeyBytes, 0);
  input.set(prefix, devPrivateKeyBytes.length);
  input.set(indexBuf, devPrivateKeyBytes.length + prefix.length);
  const derived = sha512(input).slice(0, 32);
  return new Ed25519Keypair(derived);
}

function buildProofMessage(agentPubBytes: Uint8Array, index: number): Uint8Array {
  const indexBuf = new Uint8Array(4);
  new DataView(indexBuf.buffer).setUint32(0, index, false);
  const msg = new Uint8Array(agentPubBytes.length + 4);
  msg.set(agentPubBytes, 0);
  msg.set(indexBuf, agentPubBytes.length);
  return msg;
}

export function createDerivationProof(
  devKp: Ed25519Keypair,
  agentPubBytes: Uint8Array,
  index: number
): { developer_public_key: string; entity_index: number; developer_signature: string } {
  const message = buildProofMessage(agentPubBytes, index);
  const signature = sign(devKp.privateKeyBytes, message);
  return {
    developer_public_key: devKp.publicKeyString,
    entity_index: index,
    developer_signature: signature,
  };
}

export function verifyDerivationProof(
  proof: { developer_public_key: string; entity_index: number; developer_signature: string },
  agentPubB64: string
): boolean {
  const agentPubBytes = fromBase64(agentPubB64);
  const index = proof.entity_index;
  const message = buildProofMessage(agentPubBytes, index);
  let devPub = proof.developer_public_key;
  if (devPub.startsWith("ed25519:")) devPub = devPub.slice(8);
  return verify(devPub, message, proof.developer_signature);
}
