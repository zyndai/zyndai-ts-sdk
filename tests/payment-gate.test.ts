/**
 * G19: an SDK-hosted agent asks for x402 payment, and the SDK client pays it.
 *
 * Runs a real A2AServer, a real A2AClient, and an in-process facilitator that checks the EIP-712
 * signature of every payment, so the signing on one side and the verification on the other are
 * tested against each other (not against fixtures).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { verifyTypedData } from "viem";
import { A2AServer } from "../src/a2a/server";
import { A2AClient } from "../src/a2a/client";
import { PaymentRefusedError } from "../src/a2a/payment-client";
import { X402PaymentGate } from "../src/a2a/payment-gate";
import { X402PaymentProcessor } from "../src/payment";
import { generateKeypair, generateEntityId } from "../src/identity";
import { decodePaymentRequiredHeader } from "@x402/core/http";

const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

interface Facilitator {
  url: string;
  verifies: number;
  settles: number;
  /** Make /verify answer `{isValid:false}`. */
  rejectVerify: boolean;
  /** Make /settle answer `{success:false}`. */
  failSettle: boolean;
  /** Make /verify answer 500. */
  down: boolean;
  close(): Promise<void>;
}

async function startFacilitator(): Promise<Facilitator> {
  const f = { verifies: 0, settles: 0, rejectVerify: false, failSettle: false, down: false } as Facilitator;
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
  });
  app.post("/verify", async (req, res) => {
    f.verifies++;
    if (f.down) return void res.status(500).json({ error: "boom" });
    const { paymentPayload: p, paymentRequirements: r } = req.body;
    const a = p.payload.authorization;
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: r.extra.name, version: r.extra.version, chainId: 84532, verifyingContract: r.asset },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: p.payload.signature,
    });
    if (f.rejectVerify || !ok || a.value !== r.amount || a.to.toLowerCase() !== r.payTo.toLowerCase()) {
      return void res.json({ isValid: false, invalidReason: f.rejectVerify ? "insufficient_funds" : "invalid_signature" });
    }
    res.json({ isValid: true, payer: a.from });
  });
  app.post("/settle", (req, res) => {
    f.settles++;
    if (f.failSettle) return void res.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK });
    res.json({ success: true, transaction: `0xtx${f.settles}`, network: NETWORK, payer: req.body.paymentPayload.payload.authorization.from });
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  f.url = `http://127.0.0.1:${port}`;
  f.close = () => new Promise((r) => server.close(() => r()));
  return f;
}

interface Agent {
  server: A2AServer;
  url: string;
  payTo: string;
}

async function startAgent(opts: { facilitator?: Facilitator; price?: string; handler?: Parameters<A2AServer["setHandler"]>[0] }): Promise<Agent> {
  const keypair = generateKeypair();
  const entityId = generateEntityId(keypair.publicKeyBytes, "agent");
  const payTo = new X402PaymentProcessor({ ed25519PrivateKeyBytes: keypair.privateKeyBytes }).address;
  const server = new A2AServer({
    entityId,
    keypair,
    agentCardBuilder: () => ({ name: "paid", url: "http://example.test/a2a/v1" }),
    host: "127.0.0.1",
    port: 0,
    ...(opts.facilitator
      ? { payment: { price: opts.price ?? "$0.01", payTo, network: NETWORK, facilitatorUrl: opts.facilitator.url } }
      : {}),
  });
  server.setHandler(opts.handler ?? (async () => "pong"));
  await server.start();
  return { server, url: server.a2aUrl, payTo };
}

function newClient(payment?: ConstructorParameters<typeof A2AClient>[0]["payment"]): A2AClient {
  const keypair = generateKeypair();
  return new A2AClient({
    keypair,
    entityId: generateEntityId(keypair.publicKeyBytes, "agent"),
    ...(payment ? { payment } : {}),
  });
}

describe("G19: SDK server asks for x402 payment", () => {
  let fac: Facilitator;
  const agents: Agent[] = [];

  beforeEach(async () => {
    fac = await startFacilitator();
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.server.stop();
    await fac.close();
  });

  const start = async (o: Parameters<typeof startAgent>[0] = {}): Promise<Agent> => {
    const a = await startAgent({ facilitator: fac, ...o });
    agents.push(a);
    return a;
  };

  it("answers an unpaid call with HTTP 402 and a PAYMENT-REQUIRED challenge", async () => {
    const agent = await start();
    const resp = await fetch(agent.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] } } }),
    });
    expect(resp.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(resp.headers.get("payment-required")!);
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    const req = challenge.accepts[0]!;
    expect(req).toMatchObject({ scheme: "exact", network: NETWORK, amount: "10000", payTo: agent.payTo });
    expect(String(req.asset).toLowerCase()).toBe(USDC.toLowerCase());
    const body = (await resp.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32103);
    expect(fac.settles).toBe(0);
  });

  it("without payment enabled, the SDK client surfaces the 402 as an error", async () => {
    const agent = await start();
    await expect(newClient().sync({ url: agent.url, text: "hi" })).rejects.toThrow(/402/);
  });

  it("a paying client gets the answer, and the payment is settled once, after the job", async () => {
    let jobRan = 0;
    const agent = await start({
      handler: async () => {
        jobRan++;
        expect(fac.settles).toBe(0); // not charged before the work is done
        return "pong";
      },
    });
    const task = await newClient(true).sync({ url: agent.url, text: "ping" });
    expect(task.status.state).toBe("completed");
    expect(jobRan).toBe(1);
    expect(fac.verifies).toBe(1);
    expect(fac.settles).toBe(1);
    expect(task.metadata?.["x402"]).toMatchObject({ settled: true, transaction: "0xtx1", network: NETWORK });
  });

  it("works through ask() as well", async () => {
    const agent = await start({ handler: async () => "pong" });
    const text = await newClient(true).ask(agent.url, "ping");
    expect(text).toContain("pong");
    expect(fac.settles).toBe(1);
  });

  it("does not charge for a job that fails", async () => {
    const agent = await start({
      handler: async () => {
        throw new Error("nope");
      },
    });
    const task = await newClient(true).sync({ url: agent.url, text: "ping" });
    expect(task.status.state).toBe("failed");
    expect(fac.verifies).toBe(1);
    expect(fac.settles).toBe(0);
  });

  it("refuses to pay more than the client's cap, and never runs the job", async () => {
    let jobRan = 0;
    const agent = await start({ price: "$0.50", handler: async () => void jobRan++ });
    await expect(newClient({ maxPaymentUsd: 0.1 }).sync({ url: agent.url, text: "x" })).rejects.toBeInstanceOf(PaymentRefusedError);
    expect(jobRan).toBe(0);
    expect(fac.verifies).toBe(0);
    // Raising the cap lets the same call through.
    const task = await newClient({ maxPaymentUsd: 1 }).sync({ url: agent.url, text: "x" });
    expect(task.status.state).toBe("completed");
  });

  it("rejects a payment the facilitator refuses, with a 402 and no job", async () => {
    fac.rejectVerify = true;
    let jobRan = 0;
    const agent = await start({ handler: async () => void jobRan++ });
    await expect(newClient(true).sync({ url: agent.url, text: "x" })).rejects.toThrow(/402/);
    expect(jobRan).toBe(0);
    expect(fac.settles).toBe(0);
  });

  it("answers 503 when the facilitator is down (not the caller's fault)", async () => {
    fac.down = true;
    const agent = await start();
    await expect(newClient(true).sync({ url: agent.url, text: "x" })).rejects.toThrow(/503/);
  });

  it("withholds the result when settlement fails after the job", async () => {
    fac.failSettle = true;
    const agent = await start({ handler: async () => "secret" });
    await expect(newClient(true).sync({ url: agent.url, text: "x" })).rejects.toThrow(/402/);
    expect(fac.settles).toBe(1);
  });

  it("one payment proof cannot pay for two jobs", async () => {
    // Build a valid proof by paying once through a tapping fetch, then replay it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const agent = await start({ handler: async () => (await gate, "pong") });

    const captured: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const sig = h.get("payment-signature");
      if (sig) captured.push(sig);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const first = newClient(true).sync({ url: agent.url, text: "a" });
      await new Promise((r) => setTimeout(r, 300)); // first call is now mid-job, holding its proof
      expect(captured).toHaveLength(1);

      const replay = await realFetch(agent.url, {
        method: "POST",
        headers: { "content-type": "application/json", "payment-signature": captured[0]! },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "text", text: "b" }] } } }),
      });
      expect(replay.status).toBe(402);
      release();
      await first;
      expect(fac.settles).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("blocking=false returns at once; the settlement lands in task.metadata afterwards", async () => {
    const agent = await start({ handler: async () => "pong" });
    const client = newClient(true);
    const started = await client.sync({ url: agent.url, text: "x", blocking: false });
    for (let i = 0; i < 40 && fac.settles === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(fac.settles).toBe(1);
    const got = await fetch(agent.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: started.id } }),
    }).then((r) => r.json() as Promise<{ result: { metadata?: Record<string, unknown> } }>);
    expect(got.result.metadata?.["x402"]).toMatchObject({ settled: true });
  });

  it("a follow-up message on a parked task rides on the first payment", async () => {
    const agent = await start({
      handler: async (_input, task) => {
        const more = await task.ask("which one?");
        return `got ${String(more.message.content)}`;
      },
    });
    const client = newClient(true);
    const parked = await client.sync({ url: agent.url, text: "start" });
    expect(parked.status.state).toBe("input-required");
    expect(fac.settles).toBe(0); // not done yet, not charged yet

    // The follow-up carries no payment header at all (plain client, no payer).
    const done = await newClient().sync({ url: agent.url, text: "blue", taskId: parked.id, contextId: parked.contextId });
    expect(done.status.state).toBe("completed");
    expect(fac.verifies).toBe(1);
    expect(fac.settles).toBe(1);
  });

  it("free agents are untouched: no gate, no 402, no facilitator calls", async () => {
    const free = await startAgent({});
    agents.push(free);
    const task = await newClient().sync({ url: free.url, text: "x" });
    expect(task.status.state).toBe("completed");
    expect(fac.verifies + fac.settles).toBe(0);
  });

  it("message/stream is gated too", async () => {
    const agent = await start();
    const resp = await fetch(agent.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "message/stream", params: { message: { kind: "message", role: "user", messageId: "m4", parts: [{ kind: "text", text: "hi" }] } } }),
    });
    expect(resp.status).toBe(402);
    expect(resp.headers.get("payment-required")).toBeTruthy();
  });

  it("re-signs the message for the paid retry, so servers that burn the auth nonce on a 402 still work", async () => {
    // Stand-in for a server that checks x-zynd-auth *before* payment (the n8n Gateway does).
    const gate = new X402PaymentGate({ price: "$0.01", payTo: "0x" + "2".repeat(40), network: NETWORK, facilitatorUrl: fac.url });
    const seen: Array<{ nonce: string; messageId: string; paid: boolean }> = [];
    const app = express();
    app.use(express.json());
    app.post("/a2a/v1", async (req, res) => {
      const m = req.body.params.message;
      seen.push({ nonce: m.metadata["x-zynd-auth"].nonce, messageId: m.messageId, paid: gate.hasPayment(req.headers) });
      if (seen.filter((s) => s.nonce === m.metadata["x-zynd-auth"].nonce).length > 1) {
        return void res.status(401).json({ jsonrpc: "2.0", id: req.body.id, error: { code: -32101, message: "nonce already used" } });
      }
      if (!gate.hasPayment(req.headers)) {
        const err = await gate.challenge("http://x/a2a/v1");
        res.setHeader("PAYMENT-REQUIRED", err.header);
        return void res.status(402).json({ jsonrpc: "2.0", id: req.body.id, error: { code: -32103, message: err.message } });
      }
      res.json({ jsonrpc: "2.0", id: req.body.id, result: { kind: "task", id: "t1", contextId: "c1", status: { state: "completed" } } });
    });
    const srv = createServer(app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/a2a/v1`;
      const task = await newClient(true).sync({ url, text: "hi" });
      expect(task.status.state).toBe("completed");
      expect(seen.map((s) => s.paid)).toEqual([false, true]);
      expect(seen[1]!.nonce).not.toBe(seen[0]!.nonce);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("rejects a bad gate configuration up front", () => {
    expect(() => new X402PaymentGate({ price: 0, payTo: "0x" + "1".repeat(40) })).toThrow(/price/);
    expect(() => new X402PaymentGate({ price: "$0.01", payTo: "nope" })).toThrow(/payTo/);
  });
});
