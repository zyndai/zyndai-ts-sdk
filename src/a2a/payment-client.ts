/**
 * Outbound x402 payments for the A2A client (G19, client half).
 *
 * When a call comes back HTTP 402, `A2APayer` reads the server's `PAYMENT-REQUIRED` challenge,
 * signs an EIP-3009 authorization with the caller's EVM key and returns the `PAYMENT-SIGNATURE`
 * header for one retry. Opt-in: an `A2AClient` built without `payment` never signs anything.
 *
 * Safety rails: a hard USD cap per call (default $0.10), and only assets whose decimals are known
 * are priced, so an unknown token cannot sneak past the cap.
 */

import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { Ed25519Keypair } from "../identity.js";
import { X402PaymentProcessor } from "../payment.js";

export type ClientEvmSigner = Parameters<typeof registerExactEvmScheme>[1]["signer"];

export const DEFAULT_MAX_PAYMENT_USD = 0.1;

/** Assets priced 1:1 in USD, by lower-cased address -> decimals. */
const KNOWN_STABLECOINS: Record<string, number> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": 6, // USDC, Base Sepolia
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC, Base
};

export interface ClientPaymentOptions {
  /** Most the client will pay for one call, in USD. Default 0.10. */
  maxPaymentUsd?: number;
  /**
   * EVM signer that pays. Default: the key derived from the client's Ed25519 identity
   * (SHA-256 of the seed), i.e. the same address the SDK shows as the agent's wallet.
   */
  signer?: ClientEvmSigner;
  /** Extra stablecoins you trust to be worth $1, by address -> decimals. */
  assets?: Record<string, number>;
}

/** The server asked for more than the cap, or for something this client will not pay. */
export class PaymentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRefusedError";
  }
}

export class A2APayer {
  readonly maxPaymentUsd: number;
  private readonly http: x402HTTPClient;
  private readonly assets: Record<string, number>;

  constructor(opts: ClientPaymentOptions & { keypair: Ed25519Keypair }) {
    this.maxPaymentUsd = opts.maxPaymentUsd ?? DEFAULT_MAX_PAYMENT_USD;
    if (!(this.maxPaymentUsd > 0)) throw new Error("payment.maxPaymentUsd must be > 0");
    this.assets = { ...KNOWN_STABLECOINS };
    for (const [addr, decimals] of Object.entries(opts.assets ?? {})) this.assets[addr.toLowerCase()] = decimals;

    const signer =
      opts.signer ??
      (new X402PaymentProcessor({ ed25519PrivateKeyBytes: opts.keypair.privateKeyBytes }).account as unknown as ClientEvmSigner);

    const within: PaymentPolicy = (_v, reqs) => reqs.filter((r) => this.usd(r) !== undefined && (this.usd(r) as number) <= this.maxPaymentUsd);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    client.registerPolicy(within);
    this.http = new x402HTTPClient(client);
  }

  /** USD value of a requirement, or undefined when the asset is not a trusted stablecoin. */
  private usd(r: PaymentRequirements): number | undefined {
    const decimals = this.assets[String(r.asset).toLowerCase()];
    if (decimals === undefined || !/^\d+$/.test(String(r.amount))) return undefined;
    return Number(BigInt(r.amount)) / 10 ** decimals;
  }

  /**
   * Answer a 402. Returns the headers to send on the retry. Throws PaymentRefusedError when the
   * challenge is unreadable, too expensive, or in a token/scheme this client cannot pay with.
   */
  async answer(resp: Response, body: unknown): Promise<Record<string, string>> {
    // Our servers put the challenge in the PAYMENT-REQUIRED header; the JSON-RPC error carries a copy.
    const rpcCopy = (body as { error?: { data?: { x402?: unknown } } } | null)?.error?.data?.x402;
    let required;
    try {
      required = this.http.getPaymentRequiredResponse((name) => resp.headers.get(name), rpcCopy ?? body);
    } catch (err) {
      throw new PaymentRefusedError(`Server asked for payment in a form this client cannot read: ${(err as Error).message}`);
    }
    try {
      const payload = await this.http.createPaymentPayload(required);
      return this.http.encodePaymentSignatureHeader(payload);
    } catch (err) {
      const asks = required.accepts.map((r) => {
        const usd = this.usd(r);
        return usd === undefined ? `${r.amount} of ${r.asset}` : `$${usd}`;
      });
      throw new PaymentRefusedError(
        `Refusing to pay (${asks.join(" or ")}; limit $${this.maxPaymentUsd}, trusted stablecoins only): ${(err as Error).message}`,
      );
    }
  }
}
