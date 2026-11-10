/**
 * Inbound x402 payment gate for the A2A server (G19).
 *
 * x402 v2, `exact` scheme on an EVM network (default Base Sepolia test USDC).
 * Mirrors the Zynd n8n Gateway so a Gateway listing and an SDK-hosted agent
 * behave identically to a paying caller:
 *
 *   1. no payment header       -> HTTP 402 + `PAYMENT-REQUIRED` (nothing consumed)
 *   2. payment header present  -> verify with the facilitator, *before* the job runs
 *   3. job completed           -> settle on chain, return `PAYMENT-RESPONSE`
 *      job failed / cancelled  -> release; the caller is never charged
 *
 * Header names follow `@x402/core` v2: PAYMENT-REQUIRED (response),
 * PAYMENT-SIGNATURE (request), PAYMENT-RESPONSE (response).
 */

import type { IncomingHttpHeaders } from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

export const DEFAULT_X402_NETWORK: Network = "eip155:84532"; // Base Sepolia
export const DEFAULT_X402_FACILITATOR_URL = "https://x402.org/facilitator";
/** The signed authorization must outlive the job, because settlement happens after it. */
export const DEFAULT_PAYMENT_TIMEOUT_SECONDS = 600;

export interface PaymentGateOptions {
  /** Price of one call, e.g. `"$0.01"`, `"0.01"` or `0.01` (USD). Must be > 0. */
  price: string | number;
  /** EVM address that receives the payment. */
  payTo: string;
  /** CAIP-2 network id. Default `eip155:84532` (Base Sepolia). */
  network?: Network;
  /** x402 facilitator base URL. Default `https://x402.org/facilitator`. */
  facilitatorUrl?: string;
  /** How long the signed authorization stays valid. Default 600 s. */
  maxTimeoutSeconds?: number;
  /** Shown to the payer in the 402 challenge. */
  description?: string;
  /** Inject a facilitator (tests, or a facilitator with auth headers). Overrides `facilitatorUrl`. */
  facilitator?: FacilitatorClient;
}

export interface VerifiedPayment {
  payer: string;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  /** EIP-3009 nonce, lower-cased. Used to stop one proof paying for two jobs. */
  nonce: string | undefined;
}

export interface SettledPayment {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  /** Base64 value for the `PAYMENT-RESPONSE` header. */
  header: string;
  errorReason?: string;
}

/** The caller must pay (or its payment was rejected). Renders as HTTP 402. */
export class PaymentRequiredError extends Error {
  /** Base64 value for the `PAYMENT-REQUIRED` header. */
  readonly header: string;
  readonly challenge: PaymentRequired;
  readonly reason: string;
  constructor(message: string, challenge: PaymentRequired, reason: string) {
    super(message);
    this.name = "PaymentRequiredError";
    this.challenge = challenge;
    this.header = encodePaymentRequiredHeader(challenge);
    this.reason = reason;
  }
}

/** The facilitator could not be reached. Renders as HTTP 503: not the caller's fault. */
export class PaymentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentUnavailableError";
  }
}

export function headerValue(headers: IncomingHttpHeaders, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = headers[n.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    if (v) return v;
  }
  return undefined;
}

const SIGNATURE_HEADERS = ["payment-signature", "x-payment"];

const sameAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `"$0.01"`, `"0.01 USDC"`, `0.01` -> a positive number, or undefined. */
export function parsePriceUsd(price: string | number | undefined): number | undefined {
  if (price === undefined) return undefined;
  const n = typeof price === "number" ? price : parseFloat(String(price).replace(/^[^0-9.]+/, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class X402PaymentGate {
  readonly priceUsd: number;
  readonly payTo: string;
  readonly network: Network;
  private readonly server: x402ResourceServer;
  private readonly timeout: number;
  private readonly description: string | undefined;
  private initialized: Promise<void> | null = null;
  /** Nonces accepted by this process -> expiry (ms). A proof can pay for one in-flight job only. */
  private readonly claimed = new Map<string, number>();

  constructor(opts: PaymentGateOptions) {
    const price = parsePriceUsd(opts.price);
    if (price === undefined) {
      throw new Error(`payment gate: price must be a positive amount, got ${JSON.stringify(opts.price)}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.payTo)) {
      throw new Error(`payment gate: payTo is not an EVM address: ${opts.payTo}`);
    }
    this.priceUsd = price;
    this.payTo = opts.payTo;
    this.network = opts.network ?? DEFAULT_X402_NETWORK;
    this.timeout = opts.maxTimeoutSeconds ?? DEFAULT_PAYMENT_TIMEOUT_SECONDS;
    this.description = opts.description;

    const facilitator =
      opts.facilitator ??
      new HTTPFacilitatorClient({ url: (opts.facilitatorUrl ?? DEFAULT_X402_FACILITATOR_URL).replace(/\/+$/, "") });
    this.server = new x402ResourceServer(facilitator);
    registerExactEvmScheme(this.server, { networks: [this.network] });
  }

  /** True when the request carries a payment proof at all. */
  hasPayment(headers: IncomingHttpHeaders): boolean {
    return headerValue(headers, ...SIGNATURE_HEADERS) !== undefined;
  }

  /** Build a 402 for a caller that has not paid (or paid wrongly). */
  async challenge(resourceUrl: string, error = "Payment required", reason = "missing_payment"): Promise<PaymentRequiredError> {
    const requirements = await this.requirements();
    const challenge = await this.server.createPaymentRequiredResponse(
      requirements,
      { url: resourceUrl, ...(this.description ? { description: this.description } : {}), mimeType: "application/json" },
      error,
    );
    return new PaymentRequiredError(error, challenge, reason);
  }

  /**
   * Check a payment proof against this agent's price: structure, requirements match, in-process
   * replay, then the facilitator's /verify. Throws PaymentRequiredError (caller's problem) or
   * PaymentUnavailableError (facilitator down).
   */
  async verify(headers: IncomingHttpHeaders, resourceUrl: string): Promise<VerifiedPayment> {
    const raw = headerValue(headers, ...SIGNATURE_HEADERS);
    if (!raw) throw await this.challenge(resourceUrl);

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(raw);
    } catch {
      throw await this.challenge(resourceUrl, "Unreadable payment header", "malformed");
    }

    const [required] = await this.requirements();
    const a = payload.accepted;
    if (
      !required ||
      !a ||
      a.scheme !== required.scheme ||
      a.network !== required.network ||
      !sameAddr(String(a.asset), required.asset) ||
      !sameAddr(String(a.payTo), required.payTo) ||
      String(a.amount) !== required.amount
    ) {
      throw await this.challenge(resourceUrl, "Payment does not match the requirements", "requirements_mismatch");
    }

    const auth = (payload.payload as { authorization?: { from?: string; nonce?: string; validBefore?: string } } | undefined)?.authorization;
    const nonce = auth?.nonce?.toLowerCase();
    if (nonce) {
      const expiresAt = Number(auth?.validBefore ?? 0) * 1000 || Date.now() + this.timeout * 1000;
      if (!this.claim(nonce, expiresAt)) {
        throw await this.challenge(resourceUrl, "Payment authorization was already used", "replayed");
      }
    }

    try {
      const res = await this.server.verifyPayment(payload, required);
      if (!res.isValid) {
        this.unclaim(nonce);
        throw await this.challenge(resourceUrl, "Payment rejected by the facilitator", res.invalidReason ?? "invalid");
      }
      return { payer: res.payer ?? auth?.from ?? "", payload, requirements: required, nonce };
    } catch (err) {
      this.unclaim(nonce);
      if (err instanceof PaymentRequiredError) throw err;
      // verifyPayment throws on a facilitator that answers 4xx with an invalid-payment body, too.
      const reason = (err as { invalidReason?: string }).invalidReason;
      if (reason) throw await this.challenge(resourceUrl, "Payment rejected by the facilitator", reason);
      throw new PaymentUnavailableError(`Payment facilitator unavailable: ${(err as Error).message}`);
    }
  }

  /** Submit the verified payment on chain. Call once, after the job completed. */
  async settle(v: VerifiedPayment): Promise<SettledPayment> {
    try {
      const res = await this.server.settlePayment(v.payload, v.requirements);
      const out: SettledPayment = {
        success: res.success === true,
        transaction: res.transaction ?? "",
        network: res.network ?? v.requirements.network,
        payer: res.payer ?? v.payer,
        header: encodePaymentResponseHeader(res),
        ...(res.errorReason ? { errorReason: res.errorReason } : {}),
      };
      if (!out.success) this.unclaim(v.nonce);
      return out;
    } catch (err) {
      this.unclaim(v.nonce);
      const e = err as { errorReason?: string; message?: string };
      const failed = { success: false as const, transaction: "", network: v.requirements.network, payer: v.payer, errorReason: e.errorReason ?? e.message ?? "settle_failed" };
      return { ...failed, header: encodePaymentResponseHeader(failed) };
    }
  }

  /** The job will not be charged (failed, cancelled, rejected): let the caller reuse the authorization. */
  release(v: VerifiedPayment): void {
    this.unclaim(v.nonce);
  }

  // --- internals -----------------------------------------------------------------------------

  private async requirements(): Promise<PaymentRequirements[]> {
    await this.ensureInitialized();
    return this.server.buildPaymentRequirements({
      scheme: "exact",
      payTo: this.payTo,
      price: `$${this.priceUsd}`,
      network: this.network,
      maxTimeoutSeconds: this.timeout,
    });
  }

  /** Fetch the facilitator's /supported once. A failure is not cached, so a later call retries. */
  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.server.initialize().catch((err) => {
        this.initialized = null;
        throw new PaymentUnavailableError(`Payment facilitator unavailable: ${(err as Error).message}`);
      });
    }
    return this.initialized;
  }

  private claim(nonce: string, expiresAtMs: number): boolean {
    const now = Date.now();
    for (const [n, exp] of this.claimed) if (exp < now) this.claimed.delete(n);
    if (this.claimed.has(nonce)) return false;
    this.claimed.set(nonce, expiresAtMs);
    return true;
  }

  private unclaim(nonce: string | undefined): void {
    if (nonce) this.claimed.delete(nonce);
  }
}
