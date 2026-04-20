import { describe, it, expect } from "vitest";
import { buildEndpoints, buildEntityCard, signEntityCard, canonicalJson } from "../src/entity-card";
import { generateKeypair, keypairFromPrivateBytes, verify } from "../src/identity";

describe("buildEndpoints", () => {
  it("builds correct paths from a base URL", () => {
    const ep = buildEndpoints("https://agent.example.com");
    expect(ep.invoke).toBe("https://agent.example.com/webhook/sync");
    expect(ep.invoke_async).toBe("https://agent.example.com/webhook");
    expect(ep.health).toBe("https://agent.example.com/health");
    expect(ep.agent_card).toBe("https://agent.example.com/.well-known/agent.json");
  });

  it("strips trailing slashes from base URL", () => {
    const ep = buildEndpoints("https://agent.example.com///");
    expect(ep.invoke).toBe("https://agent.example.com/webhook/sync");
  });

  it("handles URL with a path prefix", () => {
    const ep = buildEndpoints("https://example.com/agents/foo");
    expect(ep.invoke).toBe("https://example.com/agents/foo/webhook/sync");
    expect(ep.health).toBe("https://example.com/agents/foo/health");
  });
});

describe("buildEntityCard", () => {
  it("produces the correct top-level fields", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:abc123",
      name: "Test Agent",
      description: "A test agent",
      entityUrl: "https://agent.example.com",
      keypair: kp,
      version: "2.0.0",
    });

    expect(card.entity_id).toBe("zns:abc123");
    expect(card.name).toBe("Test Agent");
    expect(card.description).toBe("A test agent");
    expect(card.public_key).toBe(kp.publicKeyString);
    expect(card.entity_url).toBe("https://agent.example.com");
    expect(card.version).toBe("2.0.0");
    expect(card.status).toBe("online");
    expect(card.signature).toBeUndefined();
  });

  it("defaults version to 1.0 when omitted", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    expect(card.version).toBe("1.0");
  });

  it("flattens capabilities dict to array of {name, category}", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://x.com",
      keypair: kp,
      capabilities: { ai: ["nlp", "vision"], data: ["search"] },
    });

    expect(card.capabilities).toContainEqual({ name: "nlp", category: "ai" });
    expect(card.capabilities).toContainEqual({ name: "vision", category: "ai" });
    expect(card.capabilities).toContainEqual({ name: "search", category: "data" });
    expect(card.capabilities).toHaveLength(3);
  });

  it("empty capabilities dict produces empty array", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://x.com",
      keypair: kp,
      capabilities: {},
    });
    expect(card.capabilities).toEqual([]);
  });

  it("parses price string into pricing object", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://x.com",
      keypair: kp,
      price: "$0.05",
    });

    expect(card.pricing).toBeDefined();
    expect(card.pricing!.model).toBe("per-request");
    expect(card.pricing!.currency).toBe("USDC");
    expect(card.pricing!.rates.default).toBeCloseTo(0.05);
    expect(card.pricing!.payment_methods).toContain("x402");
  });

  it("omits pricing when price is not provided", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    expect(card.pricing).toBeUndefined();
  });

  it("strips /webhook suffix from entityUrl", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://agent.example.com/webhook",
      keypair: kp,
    });
    expect(card.entity_url).toBe("https://agent.example.com");
    expect(card.endpoints.invoke).toBe("https://agent.example.com/webhook/sync");
  });

  it("strips /webhook suffix even with trailing slashes", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://agent.example.com/webhook///",
      keypair: kp,
    });
    expect(card.entity_url).toBe("https://agent.example.com");
  });

  it("does not strip /webhook when it is a path prefix, not suffix", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://agent.example.com/webhook/v2",
      keypair: kp,
    });
    expect(card.entity_url).toBe("https://agent.example.com/webhook/v2");
  });

  it("includes ISO 8601 timestamps for last_heartbeat and signed_at", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "T",
      description: "d",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    expect(card.last_heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(card.signed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("signEntityCard", () => {
  it("adds an ed25519: prefixed signature", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "Test",
      description: "desc",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    const signed = signEntityCard(card, kp);
    expect(signed.signature).toBeDefined();
    expect(signed.signature).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
  });

  it("signature is verifiable with the keypair public key", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "Test",
      description: "desc",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    const signed = signEntityCard(card, kp);

    // Reconstruct the payload the same way signEntityCard does.
    const { signature, ...cardWithoutSig } = signed;
    const payload = canonicalJson(cardWithoutSig);
    expect(verify(kp.publicKeyB64, new TextEncoder().encode(payload), signature!)).toBe(true);
  });

  it("signature is deterministic for the same card content", () => {
    const fixedKp = keypairFromPrivateBytes(new Uint8Array(32).fill(7));

    const card = buildEntityCard({
      entityId: "zns:fixed",
      name: "Fixed",
      description: "desc",
      entityUrl: "https://x.com",
      keypair: fixedKp,
    });

    // Freeze timestamps to ensure identical payloads.
    const frozenCard = { ...card, last_heartbeat: "2024-01-01T00:00:00.000Z", signed_at: "2024-01-01T00:00:00.000Z" };
    const sig1 = signEntityCard(frozenCard, fixedKp).signature;
    const sig2 = signEntityCard(frozenCard, fixedKp).signature;
    expect(sig1).toBe(sig2);
  });

  it("does not mutate the original card", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "Test",
      description: "desc",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    signEntityCard(card, kp);
    expect(card.signature).toBeUndefined();
  });

  it("re-signing replaces old signature without including it in the payload", () => {
    const kp = generateKeypair();
    const card = buildEntityCard({
      entityId: "zns:test",
      name: "Test",
      description: "desc",
      entityUrl: "https://x.com",
      keypair: kp,
    });
    const signed1 = signEntityCard(card, kp);
    const frozenCard = { ...signed1, last_heartbeat: card.last_heartbeat, signed_at: card.signed_at };
    const signed2 = signEntityCard(frozenCard, kp);
    // Both were signed over a card without the old signature, so should match.
    expect(signed1.signature).toBe(signed2.signature);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys alphabetically", () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects with sorted keys", () => {
    const result = canonicalJson({ b: { z: 1, a: 2 }, a: "x" });
    expect(result).toBe('{"a":"x","b":{"a":2,"z":1}}');
  });

  it("preserves array element order", () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles null", () => {
    expect(canonicalJson(null)).toBe("null");
  });

  it("handles string, number, boolean primitives", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("produces no whitespace", () => {
    const result = canonicalJson({ a: 1, b: [2, 3] });
    expect(result).not.toContain(" ");
    expect(result).not.toContain("\n");
  });
});
