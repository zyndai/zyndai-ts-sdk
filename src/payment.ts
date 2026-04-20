import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { privateKeyToAccount } from "viem/accounts";

export interface X402PaymentProcessorOptions {
  ed25519PrivateKeyBytes?: Uint8Array;
  /** Base64-encoded seed (legacy path, matches Python SDK agentSeed). */
  agentSeed?: string;
  maxPaymentUsd?: number;
}

export class X402PaymentProcessor {
  readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly address: string;

  constructor(opts: X402PaymentProcessorOptions) {
    let ethKeyBytes: Uint8Array;

    if (opts.agentSeed) {
      const seedBytes = Buffer.from(opts.agentSeed, "base64");
      ethKeyBytes = sha256(seedBytes);
    } else if (opts.ed25519PrivateKeyBytes) {
      ethKeyBytes = sha256(opts.ed25519PrivateKeyBytes);
    } else {
      throw new Error("Either ed25519PrivateKeyBytes or agentSeed must be provided");
    }

    const ethPrivKey = `0x${bytesToHex(ethKeyBytes)}` as `0x${string}`;
    this.account = privateKeyToAccount(ethPrivKey);
    this.address = this.account.address;
  }
}
