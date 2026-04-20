import { describe, it, expect } from "vitest";
import { X402PaymentProcessor } from "../src/payment";
import { generateKeypair } from "../src/identity";

describe("X402PaymentProcessor", () => {
  it("initializes from Ed25519 private key bytes", () => {
    const kp = generateKeypair();
    const proc = new X402PaymentProcessor({ ed25519PrivateKeyBytes: kp.privateKeyBytes });
    expect(proc.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("derives consistent ETH address from same key", () => {
    const kp = generateKeypair();
    const p1 = new X402PaymentProcessor({ ed25519PrivateKeyBytes: kp.privateKeyBytes });
    const p2 = new X402PaymentProcessor({ ed25519PrivateKeyBytes: kp.privateKeyBytes });
    expect(p1.address).toBe(p2.address);
  });

  it("address is 42 chars (0x + 40 hex)", () => {
    const kp = generateKeypair();
    const proc = new X402PaymentProcessor({ ed25519PrivateKeyBytes: kp.privateKeyBytes });
    expect(proc.address).toHaveLength(42);
  });

  it("initializes from base64 agent seed", () => {
    const seed = Buffer.from("a]J\\xc7\\x85", "binary").toString("base64");
    const proc = new X402PaymentProcessor({ agentSeed: btoa("test-seed-32-bytes-long-enough!!") });
    expect(proc.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("throws without any key material", () => {
    expect(() => new X402PaymentProcessor({})).toThrow();
  });
});
