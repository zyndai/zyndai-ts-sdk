/** G19 wiring: ZyndAIAgent config -> payment gate. Opt-in, needs a price, honours env. */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ZyndAIAgent } from "../src/agent";
import { generateKeypair, saveKeypair } from "../src/identity";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zynd-pay-"));
const kpPath = path.join(tmp, "kp.json");
saveKeypair(generateKeypair(), kpPath);

// A local facilitator that only answers /supported, so these tests never touch the network.
let facilitator: Server;
const base = { name: "pay-test", keypairPath: kpPath, serverHost: "127.0.0.1", serverPort: 0, paymentFacilitatorUrl: "" };
beforeAll(async () => {
  facilitator = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }));
  });
  await new Promise<void>((r) => facilitator.listen(0, "127.0.0.1", r));
  base.paymentFacilitatorUrl = `http://127.0.0.1:${(facilitator.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => facilitator.close(() => r())));

async function post(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m", parts: [{ kind: "text", text: "hi" }] } } }),
  });
}

describe("ZyndAIAgent payment wiring (G19)", () => {
  const started: ZyndAIAgent[] = [];
  const saved = { ...process.env };
  afterEach(async () => {
    for (const a of started.splice(0)) await a.server.stop();
    process.env = { ...saved };
  });
  const run = async (cfg: Record<string, unknown>): Promise<ZyndAIAgent> => {
    const a = new ZyndAIAgent({ ...base, ...cfg } as never);
    a.onMessage(async () => "pong");
    await a.server.start();
    started.push(a);
    return a;
  };

  it("a price alone only advertises: calls stay free (no surprise charging after upgrade)", async () => {
    const a = await run({ price: "$0.01" });
    expect((await post(a.a2aUrl)).status).toBe(200);
  });

  it("enforcePayment + price: 402 to the agent's own wallet, for the advertised price", async () => {
    const a = await run({ price: "$0.01", enforcePayment: true });
    const r = await post(a.a2aUrl);
    expect(r.status).toBe(402);
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const [req] = decodePaymentRequiredHeader(r.headers.get("payment-required")!).accepts;
    expect(req!.payTo).toBe(a.payToAddress);
    expect(req!.amount).toBe("10000");
  });

  it("entityPricing.base_price_usd works as the price source", async () => {
    const a = await run({ entityPricing: { base_price_usd: 0.25, currency: "USDC" }, enforcePayment: true });
    const r = await post(a.a2aUrl);
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    expect(decodePaymentRequiredHeader(r.headers.get("payment-required")!).accepts[0]!.amount).toBe("250000");
  });

  it("ZYND_ENFORCE_PAYMENT=1 switches it on without code changes", async () => {
    process.env["ZYND_ENFORCE_PAYMENT"] = "1";
    const a = await run({ price: "$0.01" });
    expect((await post(a.a2aUrl)).status).toBe(402);
  });

  it("enforcePayment: false beats the env var", async () => {
    process.env["ZYND_ENFORCE_PAYMENT"] = "1";
    const a = await run({ price: "$0.01", enforcePayment: false });
    expect((await post(a.a2aUrl)).status).toBe(200);
  });

  it("enforcePayment without a price fails at construction, not at the first call", () => {
    expect(() => new ZyndAIAgent({ ...base, enforcePayment: true } as never)).toThrow(/no price/);
  });
});
