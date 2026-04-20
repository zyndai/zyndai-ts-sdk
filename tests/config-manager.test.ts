import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ConfigManager, buildEntityUrl } from "../src/config-manager";
import { AgentConfigFile, ZyndBaseConfigSchema } from "../src/types";

// Registry calls are network I/O — mock them for all tests.
vi.mock("../src/registry", () => ({
  registerEntity: vi.fn().mockResolvedValue("zns:mock-entity-id"),
}));

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zynd-cfgmgr-"));
}

function withCwd(dir: string, fn: () => void): void {
  const original = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(original);
  }
}

async function withCwdAsync(dir: string, fn: () => Promise<void>): Promise<void> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(original);
  }
}

const minimalConfig = ZyndBaseConfigSchema.parse({ name: "test-agent", description: "desc" });

describe("ConfigManager.loadConfig", () => {
  it("returns null when no config exists", () => {
    const tmpDir = makeTmpDir();
    withCwd(tmpDir, () => {
      expect(ConfigManager.loadConfig()).toBeNull();
    });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("saves and loads config round-trip", () => {
    const tmpDir = makeTmpDir();
    withCwd(tmpDir, () => {
      const config: AgentConfigFile = {
        schema_version: "2.0",
        entity_id: "zns:abc123",
        public_key: "ed25519:AAAAaaaa",
        private_key: "BBBBbbbb",
        name: "round-trip-agent",
        description: "test",
        entity_url: "http://localhost:5000",
        registry_url: "https://dns01.zynd.ai",
        created_at: "2025-01-01T00:00:00.000Z",
      };

      ConfigManager.saveConfig(config);
      const loaded = ConfigManager.loadConfig();

      expect(loaded).toEqual(config);
    });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns null for corrupted JSON", () => {
    const tmpDir = makeTmpDir();
    withCwd(tmpDir, () => {
      const agentDir = path.join(tmpDir, ".agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.json"), "{ not valid json");

      expect(ConfigManager.loadConfig()).toBeNull();
    });
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("buildEntityUrl", () => {
  it("prefers entityUrl when present", () => {
    const config = ZyndBaseConfigSchema.parse({
      entityUrl: "https://example.com/agent",
      webhookUrl: "https://other.com/webhook",
    });
    expect(buildEntityUrl(config)).toBe("https://example.com/agent");
  });

  it("strips /webhook suffix from entityUrl", () => {
    const config = ZyndBaseConfigSchema.parse({
      entityUrl: "https://example.com/agent/webhook",
    });
    expect(buildEntityUrl(config)).toBe("https://example.com/agent");
  });

  it("falls back to webhookUrl when entityUrl is absent", () => {
    const config = ZyndBaseConfigSchema.parse({
      webhookUrl: "https://fallback.com/agent",
    });
    expect(buildEntityUrl(config)).toBe("https://fallback.com/agent");
  });

  it("strips /webhook suffix from webhookUrl", () => {
    const config = ZyndBaseConfigSchema.parse({
      webhookUrl: "https://fallback.com/agent/webhook",
    });
    expect(buildEntityUrl(config)).toBe("https://fallback.com/agent");
  });

  it("derives URL from host/port when neither entityUrl nor webhookUrl is set", () => {
    const config = ZyndBaseConfigSchema.parse({
      webhookHost: "192.168.1.10",
      webhookPort: 8080,
    });
    expect(buildEntityUrl(config)).toBe("http://192.168.1.10:8080");
  });

  it("maps 0.0.0.0 to localhost in derived URL", () => {
    const config = ZyndBaseConfigSchema.parse({
      webhookHost: "0.0.0.0",
      webhookPort: 5000,
    });
    expect(buildEntityUrl(config)).toBe("http://localhost:5000");
  });

  it("uses https scheme for port 443", () => {
    const config = ZyndBaseConfigSchema.parse({
      webhookHost: "0.0.0.0",
      webhookPort: 443,
    });
    expect(buildEntityUrl(config)).toBe("https://localhost:443");
  });
});

describe("ConfigManager.loadOrCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates agent config when none exists and persists it", async () => {
    const tmpDir = makeTmpDir();
    await withCwdAsync(tmpDir, async () => {
      const config = await ConfigManager.loadOrCreate(minimalConfig);

      expect(config.schema_version).toBe("2.0");
      expect(config.name).toBe("test-agent");
      expect(config.entity_id).toBeTruthy();
      expect(config.public_key).toMatch(/^ed25519:/);

      // Verify it was persisted
      const reloaded = ConfigManager.loadConfig();
      expect(reloaded).toEqual(config);
    });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns existing config without re-registering", async () => {
    const { registerEntity } = await import("../src/registry");
    const tmpDir = makeTmpDir();

    await withCwdAsync(tmpDir, async () => {
      const first = await ConfigManager.loadOrCreate(minimalConfig);
      const callsAfterFirst = vi.mocked(registerEntity).mock.calls.length;

      const second = await ConfigManager.loadOrCreate(minimalConfig);
      expect(second).toEqual(first);

      // No additional registry calls on the second load
      expect(vi.mocked(registerEntity).mock.calls.length).toBe(callsAfterFirst);
    });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws when name is missing and no config exists", async () => {
    const tmpDir = makeTmpDir();
    await withCwdAsync(tmpDir, async () => {
      const configWithoutName = ZyndBaseConfigSchema.parse({});
      await expect(ConfigManager.loadOrCreate(configWithoutName)).rejects.toThrow(
        "name is required"
      );
    });
    fs.rmSync(tmpDir, { recursive: true });
  });
});
