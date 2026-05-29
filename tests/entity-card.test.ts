import { describe, it, expect } from "vitest";
import { buildAgentCard } from "../src/a2a/card.js";
import { buildRuntimeCard } from "../src/entity-card-loader.js";
import { generateKeypair } from "../src/identity.js";

const MOCK_EVM_ADDRESS = "0x1A2b3C4d5E6f7890aAbBcCdDeEfF00112233445566".slice(0, 42);

function baseOpts(kp: ReturnType<typeof generateKeypair>) {
  return {
    name: "Test Agent",
    description: "A test agent",
    version: "0.1.0",
    baseUrl: "http://localhost:5000",
    keypair: kp,
    entityId: kp.entityId,
  };
}

describe("buildAgentCard — walletAddress in x-zynd", () => {
  it("includes walletAddress when provided", () => {
    const kp = generateKeypair();
    const card = buildAgentCard({ ...baseOpts(kp), walletAddress: MOCK_EVM_ADDRESS });
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect(xZynd["walletAddress"]).toBe(MOCK_EVM_ADDRESS);
  });

  it("omits walletAddress when not provided", () => {
    const kp = generateKeypair();
    const card = buildAgentCard(baseOpts(kp));
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect("walletAddress" in xZynd).toBe(false);
  });

  it("omits walletAddress when explicitly undefined", () => {
    const kp = generateKeypair();
    const card = buildAgentCard({ ...baseOpts(kp), walletAddress: undefined });
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect("walletAddress" in xZynd).toBe(false);
  });

  it("walletAddress survives card signing", () => {
    const kp = generateKeypair();
    const card = buildAgentCard({ ...baseOpts(kp), walletAddress: MOCK_EVM_ADDRESS });
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect(xZynd["walletAddress"]).toBe(MOCK_EVM_ADDRESS);
    expect(card.signatures).toBeDefined();
    expect(card.signatures.length).toBeGreaterThan(0);
  });

  it("coexists with other x-zynd fields", () => {
    const kp = generateKeypair();
    const card = buildAgentCard({
      ...baseOpts(kp),
      walletAddress: MOCK_EVM_ADDRESS,
      fqan: "zns:test/agent",
      category: "test",
    });
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect(xZynd["walletAddress"]).toBe(MOCK_EVM_ADDRESS);
    expect(xZynd["fqan"]).toBe("zns:test/agent");
    expect(xZynd["category"]).toBe("test");
  });
});

describe("buildRuntimeCard — walletAddress propagation", () => {
  it("propagates walletAddress to x-zynd block", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({
      config: {
        name: "Runtime Agent",
        description: "Test",
        version: "0.1.0",
        registryUrl: "https://zns01.zynd.ai",
      } as Parameters<typeof buildRuntimeCard>[0]["config"],
      baseUrl: "http://localhost:5000",
      keypair: kp,
      entityId: kp.entityId,
      walletAddress: MOCK_EVM_ADDRESS,
    });
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect(xZynd["walletAddress"]).toBe(MOCK_EVM_ADDRESS);
  });

  it("omits walletAddress when buildRuntimeCard called without it", () => {
    const kp = generateKeypair();
    const card = buildRuntimeCard({
      config: {
        name: "Runtime Agent",
        description: "Test",
        version: "0.1.0",
        registryUrl: "https://zns01.zynd.ai",
      } as Parameters<typeof buildRuntimeCard>[0]["config"],
      baseUrl: "http://localhost:5000",
      keypair: kp,
      entityId: kp.entityId,
    });
    const xZynd = card["x-zynd"] as Record<string, unknown>;
    expect("walletAddress" in xZynd).toBe(false);
  });
});
