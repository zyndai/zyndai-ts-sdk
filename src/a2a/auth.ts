/**
 * x-zynd-auth — per-message Ed25519 authorization for A2A traffic.
 *
 * Signing rule (sender side):
 *   1. Build the Message exactly as it will go on the wire.
 *   2. Set `metadata["x-zynd-auth"]` with v, entity_id, public_key, nonce,
 *      issued_at, expires_at, fqan?, developer_proof? and `signature: ""`.
 *   3. Run JCS over the entire Message (parts + metadata + everything).
 *   4. Prepend `ZYND-A2A-MSG-v1\n` (domain separation tag).
 *   5. Sign with the agent's Ed25519 private key.
 *   6. Replace `signature: ""` with `ed25519:<base64-signature>`.
 *
 * Verification rule (receiver side):
 *   1. Pull `auth = metadata["x-zynd-auth"]`. If absent, message is unsigned;
 *      handler-side policy decides whether to admit.
 *   2. Check version, expiry window, nonce-not-replayed.
 *   3. Hash `auth.public_key` and check the prefix matches `auth.entity_id`.
 *   4. Build the same byte string the sender signed: replace
 *      `signature` with `""`, JCS-canonicalize, prepend domain tag.
 *   5. Ed25519-verify with `auth.public_key`.
 *   6. (Optional) Verify `developer_proof` against the agent's pubkey.
 *
 * Replay protection:
 *   - In-process LRU cache `seenNonces[entityId][nonce]` with TTL = the
 *     skew window. Cap entries per sender to bound memory.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { sign as edSign, verify as edVerify, verifyDerivationProof } from "../identity.js";
import type { Ed25519Keypair } from "../identity.js";
import { canonicalBytes } from "./canonical.js";
import type { Message, ZyndAuth } from "./types.js";
import { ZYND_AUTH_DOMAIN_TAG, ZYND_AUTH_KEY, ZYND_AUTH_VERSION } from "./types.js";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type ZyndAuthFailureReason =
  | "missing_auth"
  | "unsupported_version"
  | "expired_or_skewed"
  | "replay_detected"
  | "entity_id_mismatch"
  | "bad_signature"
  | "bad_developer_proof"
  | "untrusted_sender";

export class ZyndAuthError extends Error {
  readonly reason: ZyndAuthFailureReason;
  constructor(reason: ZyndAuthFailureReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "ZyndAuthError";
  }
}

// -----------------------------------------------------------------------------
// Auth modes
// -----------------------------------------------------------------------------

/**
 * Strict   — reject inbound messages without valid x-zynd-auth.
 * Permissive — accept Zynd-signed messages (verified) AND unsigned messages
 *              (handler can inspect ctx.signed to decide).
 * Open     — accept everything; do not verify even if x-zynd-auth is present.
 *            Useful for pure A2A interop testing.
 */
export type AuthMode = "strict" | "permissive" | "open";

// -----------------------------------------------------------------------------
// Replay cache
// -----------------------------------------------------------------------------

const DEFAULT_SKEW_MS = 60_000; // 60 s — must be ≤ expires_at - issued_at
const MAX_NONCES_PER_SENDER = 4096;

interface NonceEntry {
  exp: number;
}

class ReplayCache {
  private readonly perSender = new Map<string, Map<string, NonceEntry>>();

  /** Returns true if the nonce was previously seen. Records it otherwise. */
  checkAndRecord(entityId: string, nonce: string, expiresAt: number): boolean {
    const now = Date.now();
    let bucket = this.perSender.get(entityId);
    if (!bucket) {
      bucket = new Map();
      this.perSender.set(entityId, bucket);
    }

    // Sweep expired entries opportunistically.
    if (bucket.size > MAX_NONCES_PER_SENDER) {
      for (const [n, e] of bucket) {
        if (e.exp < now) bucket.delete(n);
      }
      // Hard cap: if still over, drop oldest insertion order (Map is insertion-ordered).
      while (bucket.size > MAX_NONCES_PER_SENDER) {
        const first = bucket.keys().next().value;
        if (first === undefined) break;
        bucket.delete(first);
      }
    }

    const existing = bucket.get(nonce);
    if (existing && existing.exp >= now) return true;

    bucket.set(nonce, { exp: expiresAt });
    return false;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function buildSigInput(message: Message): Uint8Array {
  const canon = canonicalBytes(message);
  const tag = new TextEncoder().encode(ZYND_AUTH_DOMAIN_TAG);
  const out = new Uint8Array(tag.length + canon.length);
  out.set(tag, 0);
  out.set(canon, tag.length);
  return out;
}

function clonePlain<T>(v: T): T {
  // Plain JSON-roundtrip clone — safe for our shape (no functions, no Dates).
  return JSON.parse(JSON.stringify(v)) as T;
}

// -----------------------------------------------------------------------------
// Sign
// -----------------------------------------------------------------------------

export interface SignOptions {
  keypair: Ed25519Keypair;
  entityId: string;
  fqan?: string;
  /** When set, included on the first message of a conversation so the
   *  receiver can verify developer derivation without an Agent DNS lookup. */
  developerProof?: ZyndAuth["developer_proof"];
  /** Validity window in milliseconds. Default 60_000 (60 s). */
  ttlMs?: number;
}

/**
 * Mutates `message` to add a fully-signed `metadata["x-zynd-auth"]` block.
 * The same `message` object is also returned for fluency.
 */
export function signMessage(message: Message, opts: SignOptions): Message {
  const ttl = opts.ttlMs ?? DEFAULT_SKEW_MS;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttl);

  const auth: ZyndAuth = {
    v: ZYND_AUTH_VERSION,
    entity_id: opts.entityId,
    public_key: opts.keypair.publicKeyString,
    nonce: toBase64(randomBytes(16)),
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    signature: "", // blanked for signing
  };
  if (opts.fqan) auth.fqan = opts.fqan;
  if (opts.developerProof) auth.developer_proof = opts.developerProof;

  if (!message.metadata) (message as { metadata?: Record<string, unknown> }).metadata = {};
  (message.metadata as Record<string, unknown>)[ZYND_AUTH_KEY] = auth;

  const sigInput = buildSigInput(message);
  const signature = edSign(opts.keypair.privateKeyBytes, sigInput);
  auth.signature = signature;

  return message;
}

// -----------------------------------------------------------------------------
// Verify
// -----------------------------------------------------------------------------

export interface VerifyContext {
  /** Set to true when verification succeeded (including when mode allows
   *  unsigned messages and no x-zynd-auth was present). */
  signed: boolean;
  /** The verified entity_id, or null if no signature was present. */
  entityId: string | null;
  /** The verified FQAN (sender-supplied), or null. */
  fqan: string | null;
}

export interface VerifyOptions {
  mode?: AuthMode;
  replayCache?: ReplayCache;
  skewMs?: number;
  /** Whether to verify the developer_proof field if present. Default true. */
  verifyDeveloperProof?: boolean;
}

/**
 * Verifies the `x-zynd-auth` block on a Message. Throws ZyndAuthError on
 * any verification failure. Returns a context describing whether the
 * message was signed.
 *
 * Behavior by mode:
 *   - strict:     requires a valid x-zynd-auth; throws missing_auth otherwise.
 *   - permissive: accepts a valid x-zynd-auth OR an unsigned message; throws
 *                 only when an x-zynd-auth is present but invalid.
 *   - open:       admits everything without verification.
 */
export function verifyMessage(
  message: Message,
  opts: VerifyOptions = {},
): VerifyContext {
  const mode = opts.mode ?? "permissive";

  if (mode === "open") {
    const auth = message.metadata?.[ZYND_AUTH_KEY] as ZyndAuth | undefined;
    return {
      signed: false,
      entityId: auth?.entity_id ?? null,
      fqan: auth?.fqan ?? null,
    };
  }

  const auth = message.metadata?.[ZYND_AUTH_KEY] as ZyndAuth | undefined;

  if (!auth) {
    if (mode === "strict") {
      throw new ZyndAuthError(
        "missing_auth",
        "x-zynd-auth required (auth_mode=strict) but not present on inbound message",
      );
    }
    return { signed: false, entityId: null, fqan: null };
  }

  // 1. Version
  if (auth.v !== ZYND_AUTH_VERSION) {
    throw new ZyndAuthError(
      "unsupported_version",
      `x-zynd-auth.v=${auth.v} is not supported (server expects v=${ZYND_AUTH_VERSION})`,
    );
  }

  // 2. Expiry window
  const now = Date.now();
  const issuedAt = Date.parse(auth.issued_at);
  const expiresAt = Date.parse(auth.expires_at);
  const skew = opts.skewMs ?? DEFAULT_SKEW_MS;
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    throw new ZyndAuthError(
      "expired_or_skewed",
      "x-zynd-auth.issued_at / expires_at are not parseable RFC 3339 timestamps",
    );
  }
  if (now > expiresAt) {
    throw new ZyndAuthError(
      "expired_or_skewed",
      `x-zynd-auth expired (now=${new Date(now).toISOString()} > expires_at=${auth.expires_at})`,
    );
  }
  if (now < issuedAt - skew) {
    throw new ZyndAuthError(
      "expired_or_skewed",
      `x-zynd-auth issued in the future beyond clock skew (issued_at=${auth.issued_at})`,
    );
  }

  // 3. Replay
  if (opts.replayCache) {
    const seen = opts.replayCache.checkAndRecord(auth.entity_id, auth.nonce, expiresAt);
    if (seen) {
      throw new ZyndAuthError(
        "replay_detected",
        `nonce ${auth.nonce} already seen for ${auth.entity_id}`,
      );
    }
  }

  // 4. entity_id consistency
  const expectedPrefix = entityIdPrefix(auth.public_key);
  const actualPrefix = stripEntityIdPrefix(auth.entity_id);
  if (expectedPrefix !== actualPrefix) {
    throw new ZyndAuthError(
      "entity_id_mismatch",
      `public_key hash (${expectedPrefix}) does not match entity_id (${actualPrefix})`,
    );
  }

  // 5. Signature
  // Re-build the sig-input by blanking the signature field, JCS-canonicalizing,
  // and verifying. We clone the message so we don't mutate the caller's copy.
  const cloned = clonePlain(message);
  const clonedAuth = (cloned.metadata as Record<string, unknown>)[ZYND_AUTH_KEY] as ZyndAuth;
  clonedAuth.signature = "";
  const sigInput = buildSigInput(cloned);

  let pubKeyB64 = auth.public_key;
  if (pubKeyB64.startsWith("ed25519:")) pubKeyB64 = pubKeyB64.slice("ed25519:".length);
  const ok = edVerify(pubKeyB64, sigInput, auth.signature);
  if (!ok) {
    throw new ZyndAuthError("bad_signature", "x-zynd-auth signature did not verify");
  }

  // 6. Developer proof (optional)
  if (auth.developer_proof && (opts.verifyDeveloperProof ?? true)) {
    const ok2 = verifyDerivationProof(auth.developer_proof, pubKeyB64);
    if (!ok2) {
      throw new ZyndAuthError(
        "bad_developer_proof",
        "x-zynd-auth.developer_proof did not verify against this agent's public key",
      );
    }
  }

  return {
    signed: true,
    entityId: auth.entity_id,
    fqan: auth.fqan ?? null,
  };
}

// -----------------------------------------------------------------------------
// Utilities for entity_id <-> public_key
// -----------------------------------------------------------------------------

function entityIdPrefix(publicKeyString: string): string {
  let b64 = publicKeyString;
  if (b64.startsWith("ed25519:")) b64 = b64.slice("ed25519:".length);
  const bytes = fromBase64(b64);
  return bytesToHex(sha256(bytes)).slice(0, 32); // first 16 bytes hex
}

function stripEntityIdPrefix(entityId: string): string {
  // entity_id formats:
  //   zns:<32-hex>           (agent)
  //   zns:svc:<32-hex>       (service)
  if (entityId.startsWith("zns:svc:")) return entityId.slice("zns:svc:".length);
  if (entityId.startsWith("zns:")) return entityId.slice("zns:".length);
  return entityId;
}

// Re-export so callers can construct one without reaching into auth.ts internals.
export { ReplayCache };
