import { describe, it, expect } from "vitest";
import {
  Ed25519Keypair, generateKeypair, keypairFromPrivateBytes,
  loadKeypair, saveKeypair, generateEntityId, generateDeveloperId,
  sign, verify, deriveAgentKeypair, createDerivationProof, verifyDerivationProof,
} from "../src/identity";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Ed25519Keypair", () => {
  it("generates a keypair with 32-byte keys", () => {
    const kp = generateKeypair();
    expect(kp.privateKeyBytes).toHaveLength(32);
    expect(kp.publicKeyBytes).toHaveLength(32);
  });

  it("derives consistent entity_id from public key", () => {
    const kp = generateKeypair();
    const id1 = kp.entityId;
    const id2 = generateEntityId(kp.publicKeyBytes, "agent");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^zns:[0-9a-f]{32}$/);
  });

  it("formats public key as ed25519:<b64>", () => {
    const kp = generateKeypair();
    expect(kp.publicKeyString).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
  });

  it("reconstructs keypair from private bytes", () => {
    const kp1 = generateKeypair();
    const kp2 = keypairFromPrivateBytes(kp1.privateKeyBytes);
    expect(kp2.publicKeyB64).toBe(kp1.publicKeyB64);
    expect(kp2.entityId).toBe(kp1.entityId);
  });
});

describe("Entity ID generation", () => {
  it("generates agent-flavor ID", () => {
    const kp = generateKeypair();
    expect(generateEntityId(kp.publicKeyBytes, "agent")).toMatch(/^zns:[0-9a-f]{32}$/);
  });
  it("generates service-flavor ID", () => {
    const kp = generateKeypair();
    expect(generateEntityId(kp.publicKeyBytes, "service")).toMatch(/^zns:svc:[0-9a-f]{32}$/);
  });
  it("generates developer ID", () => {
    const kp = generateKeypair();
    expect(generateDeveloperId(kp.publicKeyBytes)).toMatch(/^zns:dev:[0-9a-f]{32}$/);
  });
});

describe("Sign and verify", () => {
  it("produces ed25519:<b64> signature", () => {
    const kp = generateKeypair();
    const sig = sign(kp.privateKeyBytes, new TextEncoder().encode("hello"));
    expect(sig).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
  });
  it("verifies valid signature", () => {
    const kp = generateKeypair();
    const msg = new TextEncoder().encode("test message");
    const sig = sign(kp.privateKeyBytes, msg);
    expect(verify(kp.publicKeyB64, msg, sig)).toBe(true);
  });
  it("rejects tampered message", () => {
    const kp = generateKeypair();
    const sig = sign(kp.privateKeyBytes, new TextEncoder().encode("original"));
    expect(verify(kp.publicKeyB64, new TextEncoder().encode("tampered"), sig)).toBe(false);
  });
  it("rejects wrong public key", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const msg = new TextEncoder().encode("test");
    const sig = sign(kp1.privateKeyBytes, msg);
    expect(verify(kp2.publicKeyB64, msg, sig)).toBe(false);
  });
  it("rejects malformed signature prefix", () => {
    const kp = generateKeypair();
    expect(verify(kp.publicKeyB64, new TextEncoder().encode("test"), "bad:sig")).toBe(false);
  });
});

describe("HD derivation", () => {
  it("derives deterministic keypair from developer key + index", () => {
    const devKp = generateKeypair();
    const a = deriveAgentKeypair(devKp.privateKeyBytes, 0);
    const b = deriveAgentKeypair(devKp.privateKeyBytes, 0);
    expect(a.publicKeyB64).toBe(b.publicKeyB64);
  });
  it("different indices produce different keys", () => {
    const devKp = generateKeypair();
    const a = deriveAgentKeypair(devKp.privateKeyBytes, 0);
    const b = deriveAgentKeypair(devKp.privateKeyBytes, 1);
    expect(a.publicKeyB64).not.toBe(b.publicKeyB64);
  });
});

describe("Derivation proof", () => {
  it("creates and verifies proof", () => {
    const devKp = generateKeypair();
    const agentKp = deriveAgentKeypair(devKp.privateKeyBytes, 0);
    const proof = createDerivationProof(devKp, agentKp.publicKeyBytes, 0);
    expect(proof.developer_public_key).toBe(devKp.publicKeyString);
    expect(proof.entity_index).toBe(0);
    expect(verifyDerivationProof(proof, agentKp.publicKeyB64)).toBe(true);
  });
  it("rejects proof with wrong agent key", () => {
    const devKp = generateKeypair();
    const agentKp = deriveAgentKeypair(devKp.privateKeyBytes, 0);
    const wrongKp = generateKeypair();
    const proof = createDerivationProof(devKp, agentKp.publicKeyBytes, 0);
    expect(verifyDerivationProof(proof, wrongKp.publicKeyB64)).toBe(false);
  });
});

describe("Keypair file I/O", () => {
  it("saves and loads keypair", () => {
    const kp = generateKeypair();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zynd-test-"));
    const filePath = path.join(tmpDir, "keypair.json");
    saveKeypair(kp, filePath);
    const loaded = loadKeypair(filePath);
    expect(loaded.publicKeyB64).toBe(kp.publicKeyB64);
    expect(loaded.privateKeyB64).toBe(kp.privateKeyB64);
    fs.rmSync(tmpDir, { recursive: true });
  });
  it("saves with derivation metadata", () => {
    const devKp = generateKeypair();
    const agentKp = deriveAgentKeypair(devKp.privateKeyBytes, 5);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zynd-test-"));
    const filePath = path.join(tmpDir, "derived.json");
    saveKeypair(agentKp, filePath, { developer_public_key: devKp.publicKeyString, entity_index: 5 });
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.derived_from.entity_index).toBe(5);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
