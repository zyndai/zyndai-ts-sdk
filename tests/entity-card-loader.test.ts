import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadEntityCard,
  resolveKeypair,
  buildRuntimeCard,
  computeCardHash,
  resolveCardFromConfig,
  loadDerivationMetadata,
} from "../src/entity-card-loader";
import { generateKeypair, keypairFromPrivateBytes, saveKeypair } from "../src/identity";
import { ZyndBaseConfigSchema } from "../src/types";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zynd-cardloader-"));
}

function cleanEnv(): void {
  delete process.env["ZYND_AGENT_KEYPAIR_PATH"];
  delete process.env["ZYND_AGENT_PRIVATE_KEY"];
}

describe("loadEntityCard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("loads a valid card with a name field", () => {
    const filePath = path.join(tmpDir, "card.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ name: "Test Agent", description: "A test", version: "2.0.0" })
    );

    const card = loadEntityCard(filePath);
    expect(card.name).toBe("Test Agent");
    expect(card.description).toBe("A test");
    expect(card.version).toBe("2.0.0");
  });

  it("loads a card with all optional fields", () => {
    const filePath = path.join(tmpDir, "card.json");
    const data = {
      name: "Full Agent",
      description: "desc",
      version: "1.0.0",
      category: "ai",
      tags: ["nlp", "search"],
      summary: "An AI agent",
      capabilities: [{ name: "search", category: "data" }],
    };
    fs.writeFileSync(filePath, JSON.stringify(data));

    const card = loadEntityCard(filePath);
    expect(card.name).toBe("Full Agent");
    expect(card.tags).toEqual(["nlp", "search"]);
    expect(card.capabilities).toHaveLength(1);
  });

  it("throws when file does not exist", () => {
    const filePath = path.join(tmpDir, "nonexistent.json");
    expect(() => loadEntityCard(filePath)).toThrow("Entity card file not found");
  });

  it("throws when file contains invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json");
    expect(() => loadEntityCard(filePath)).toThrow("Invalid JSON");
  });

  it("throws when card is missing the name field", () => {
    const filePath = path.join(tmpDir, "card.json");
    fs.writeFileSync(filePath, JSON.stringify({ description: "no name here" }));
    expect(() => loadEntityCard(filePath)).toThrow("missing required field: name");
  });

  it("throws when name field is an empty string", () => {
    const filePath = path.join(tmpDir, "card.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "   " }));
    expect(() => loadEntityCard(filePath)).toThrow("missing required field: name");
  });

  it("throws when the file contains a JSON array instead of an object", () => {
    const filePath = path.join(tmpDir, "card.json");
    fs.writeFileSync(filePath, JSON.stringify([{ name: "Agent" }]));
    expect(() => loadEntityCard(filePath)).toThrow("must be a JSON object");
  });
});

describe("resolveKeypair", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    cleanEnv();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true });
    cleanEnv();
  });

  it("resolves from ZYND_AGENT_KEYPAIR_PATH env var", () => {
    const kp = generateKeypair();
    const keypairPath = path.join(tmpDir, "kp.json");
    saveKeypair(kp, keypairPath);

    process.env["ZYND_AGENT_KEYPAIR_PATH"] = keypairPath;
    const resolved = resolveKeypair();
    expect(resolved.publicKeyString).toBe(kp.publicKeyString);
  });

  it("resolves from ZYND_AGENT_PRIVATE_KEY env var (base64)", () => {
    const kp = generateKeypair();
    process.env["ZYND_AGENT_PRIVATE_KEY"] = kp.privateKeyB64;
    const resolved = resolveKeypair();
    expect(resolved.publicKeyString).toBe(kp.publicKeyString);
  });

  it("ZYND_AGENT_KEYPAIR_PATH takes priority over ZYND_AGENT_PRIVATE_KEY", () => {
    const kpFile = generateKeypair();
    const kpEnv = generateKeypair();
    const keypairPath = path.join(tmpDir, "kp.json");
    saveKeypair(kpFile, keypairPath);

    process.env["ZYND_AGENT_KEYPAIR_PATH"] = keypairPath;
    process.env["ZYND_AGENT_PRIVATE_KEY"] = kpEnv.privateKeyB64;

    const resolved = resolveKeypair();
    expect(resolved.publicKeyString).toBe(kpFile.publicKeyString);
  });

  it("resolves from config.keypairPath", () => {
    const kp = generateKeypair();
    const keypairPath = path.join(tmpDir, "kp.json");
    saveKeypair(kp, keypairPath);

    const resolved = resolveKeypair({ keypairPath });
    expect(resolved.publicKeyString).toBe(kp.publicKeyString);
  });

  it("falls back to .agent/config.json private_key field", () => {
    const kp = generateKeypair();
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.json"),
      JSON.stringify({
        schema_version: "2.0",
        entity_id: kp.entityId,
        public_key: kp.publicKeyString,
        private_key: kp.privateKeyB64,
        name: "test",
        description: "",
        entity_url: "http://localhost:5000",
        registry_url: "https://dns01.zynd.ai",
        created_at: new Date().toISOString(),
      })
    );

    const resolved = resolveKeypair();
    expect(resolved.publicKeyString).toBe(kp.publicKeyString);
  });

  it("uses custom configDir for fallback path", () => {
    const kp = generateKeypair();
    const agentDir = path.join(tmpDir, "custom-dir");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.json"),
      JSON.stringify({ private_key: kp.privateKeyB64 })
    );

    const resolved = resolveKeypair({ configDir: "custom-dir" });
    expect(resolved.publicKeyString).toBe(kp.publicKeyString);
  });

  it("throws when no keypair source is found", () => {
    expect(() => resolveKeypair()).toThrow("No keypair found");
  });
});

describe("computeCardHash", () => {
  it("returns a 64-character hex string (SHA-256)", () => {
    const kp = generateKeypair();
    const card = {
      name: "Agent",
      description: "desc",
      capabilities: [],
      category: "ai",
      tags: ["tag1"],
      pricing: undefined,
      summary: undefined,
    };
    const hash = computeCardHash(card);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input produces same hash", () => {
    const kp = keypairFromPrivateBytes(new Uint8Array(32).fill(1));
    const card = {
      entity_id: kp.entityId,
      name: "Stable Agent",
      description: "Stable",
      public_key: kp.publicKeyString,
      entity_url: "https://example.com",
      version: "1.0.0",
      status: "active" as const,
      capabilities: [{ name: "search", category: "data" }],
      endpoints: {
        invoke: "https://example.com/webhook/sync",
        invoke_async: "https://example.com/webhook",
        health: "https://example.com/health",
        agent_card: "https://example.com/.well-known/agent.json",
      },
      last_heartbeat: "2024-01-01T00:00:00.000Z",
      signed_at: "2024-01-01T00:00:00.000Z",
    };

    const hash1 = computeCardHash(card);
    const hash2 = computeCardHash(card);
    expect(hash1).toBe(hash2);
  });

  it("changes when a hashed field changes", () => {
    const base = { name: "Agent A", description: "desc", capabilities: [] };
    const modified = { name: "Agent B", description: "desc", capabilities: [] };
    expect(computeCardHash(base)).not.toBe(computeCardHash(modified));
  });

  it("does NOT change when a non-hashed field (entity_id, signature) changes", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const shared = { name: "Same", description: "same", capabilities: [] };

    // entity_id and public_key are not in HASH_FIELDS so different keypairs should not matter
    const card1 = { ...shared, entity_id: kp1.entityId, public_key: kp1.publicKeyString };
    const card2 = { ...shared, entity_id: kp2.entityId, public_key: kp2.publicKeyString };
    expect(computeCardHash(card1)).toBe(computeCardHash(card2));
  });
});

describe("resolveCardFromConfig", () => {
  it("builds a card with name and description from config", () => {
    const config = ZyndBaseConfigSchema.parse({ name: "My Agent", description: "Does things" });
    const card = resolveCardFromConfig(config);
    expect(card.name).toBe("My Agent");
    expect(card.description).toBe("Does things");
  });

  it("converts capabilities dict to flat capability list", () => {
    const config = ZyndBaseConfigSchema.parse({
      name: "Cap Agent",
      description: "",
      capabilities: { ai: ["nlp", "vision"], data: ["search"] },
    });
    const card = resolveCardFromConfig(config);
    expect(card.capabilities).toContainEqual({ name: "nlp", category: "ai" });
    expect(card.capabilities).toContainEqual({ name: "vision", category: "ai" });
    expect(card.capabilities).toContainEqual({ name: "search", category: "data" });
    expect(card.capabilities).toHaveLength(3);
  });

  it("omits capabilities when not set in config", () => {
    const config = ZyndBaseConfigSchema.parse({ name: "No Caps", description: "" });
    const card = resolveCardFromConfig(config);
    expect(card.capabilities).toBeUndefined();
  });

  it("builds pricing from entityPricing structured field", () => {
    const config = ZyndBaseConfigSchema.parse({
      name: "Priced Agent",
      description: "",
      entityPricing: { base_price_usd: 0.02, currency: "USDC" },
    });
    const card = resolveCardFromConfig(config);
    expect(card.pricing).toBeDefined();
    expect(card.pricing!.model).toBe("per-request");
    expect(card.pricing!.currency).toBe("USDC");
    expect(card.pricing!.rates.default).toBeCloseTo(0.02);
    expect(card.pricing!.payment_methods).toContain("x402");
  });

  it("builds pricing from price string field", () => {
    const config = ZyndBaseConfigSchema.parse({
      name: "String Price",
      description: "",
      price: "$0.05",
    });
    const card = resolveCardFromConfig(config);
    expect(card.pricing).toBeDefined();
    expect(card.pricing!.rates.default).toBeCloseTo(0.05);
  });

  it("entityPricing takes priority over price string", () => {
    const config = ZyndBaseConfigSchema.parse({
      name: "Both Price",
      description: "",
      price: "$0.99",
      entityPricing: { base_price_usd: 0.01, currency: "USDC" },
    });
    const card = resolveCardFromConfig(config);
    expect(card.pricing!.rates.default).toBeCloseTo(0.01);
  });

  it("includes optional metadata fields when present", () => {
    const config = ZyndBaseConfigSchema.parse({
      name: "Meta Agent",
      description: "Has meta",
      category: "finance",
      tags: ["stock", "market"],
      summary: "Trades stocks",
    });
    const card = resolveCardFromConfig(config);
    expect(card.category).toBe("finance");
    expect(card.tags).toEqual(["stock", "market"]);
    expect(card.summary).toBe("Trades stocks");
  });
});

describe("buildRuntimeCard", () => {
  it("merges static metadata with runtime identity fields", () => {
    const kp = generateKeypair();
    const staticCard = {
      name: "Runtime Agent",
      description: "A runtime card",
      version: "2.0.0",
      category: "ai",
      tags: ["nlp"],
      summary: "Summary here",
      capabilities: [{ name: "search", category: "data" }],
    };

    const card = buildRuntimeCard(staticCard, "https://agent.example.com", kp);

    expect(card.name).toBe("Runtime Agent");
    expect(card.description).toBe("A runtime card");
    expect(card.version).toBe("2.0.0");
    expect(card.category).toBe("ai");
    expect(card.tags).toEqual(["nlp"]);
    expect(card.summary).toBe("Summary here");
    expect(card.capabilities).toEqual([{ name: "search", category: "data" }]);
  });

  it("populates runtime identity fields from the keypair", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({ name: "Agent" }, "https://example.com", kp);

    expect(card.entity_id).toBe(kp.entityId);
    expect(card.public_key).toBe(kp.publicKeyString);
    expect(card.entity_url).toBe("https://example.com");
    expect(card.status).toBe("online");
  });

  it("builds correct endpoint URLs from the base URL", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({ name: "Agent" }, "https://agent.example.com", kp);

    expect(card.endpoints.invoke).toBe("https://agent.example.com/webhook/sync");
    expect(card.endpoints.health).toBe("https://agent.example.com/health");
    expect(card.endpoints.agent_card).toBe("https://agent.example.com/.well-known/agent.json");
  });

  it("adds a valid ed25519 signature", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({ name: "Agent" }, "https://example.com", kp);
    expect(card.signature).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
  });

  it("defaults version to 1.0 when not provided in static card", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({ name: "Agent" }, "https://example.com", kp);
    expect(card.version).toBe("1.0");
  });

  it("strips trailing slashes from base URL", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({ name: "Agent" }, "https://example.com///", kp);
    expect(card.entity_url).toBe("https://example.com");
    expect(card.endpoints.invoke).toBe("https://example.com/webhook/sync");
  });

  it("includes timestamps for last_heartbeat and signed_at", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({ name: "Agent" }, "https://example.com", kp);
    expect(card.last_heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(card.signed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("loadDerivationMetadata", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns null when keypair has no derived_from field", () => {
    const kp = generateKeypair();
    const keypairPath = path.join(tmpDir, "kp.json");
    saveKeypair(kp, keypairPath);

    expect(loadDerivationMetadata(keypairPath)).toBeNull();
  });

  it("returns the derived_from object when present", () => {
    const kp = generateKeypair();
    const derivationMeta = {
      developer_public_key: "ed25519:AAAA",
      entity_index: 0,
      developer_signature: "ed25519:BBBB",
    };
    const keypairPath = path.join(tmpDir, "kp.json");
    saveKeypair(kp, keypairPath, derivationMeta);

    const result = loadDerivationMetadata(keypairPath);
    expect(result).toEqual(derivationMeta);
  });

  it("throws when file does not exist", () => {
    const keypairPath = path.join(tmpDir, "missing.json");
    expect(() => loadDerivationMetadata(keypairPath)).toThrow("Failed to read keypair");
  });

  it("throws when file contains invalid JSON", () => {
    const keypairPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(keypairPath, "not json");
    expect(() => loadDerivationMetadata(keypairPath)).toThrow("Invalid JSON");
  });
});
