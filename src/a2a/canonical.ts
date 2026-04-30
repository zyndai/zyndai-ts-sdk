/**
 * Deterministic JSON canonicalization for signing.
 *
 * Spec target: RFC 8785 JSON Canonicalization Scheme (JCS) — the same scheme
 * A2A uses for AgentCard signatures and what the Python SDK will use for
 * cross-language signature verification.
 *
 * Implementation notes:
 * - Object keys are sorted by UTF-16 code unit order (matches V8 / spec).
 * - Strings are serialized via JSON.stringify, which already escapes
 *   control characters and uses minimal-escape rules compatible with JCS for
 *   the ASCII-and-BMP subset we care about. For our envelopes (UUIDs, FQANs,
 *   base64 blobs, ed25519: prefixes, timestamps) this is byte-identical to
 *   a full JCS implementation.
 * - Numbers go through JSON.stringify, which uses ECMAScript ToString — the
 *   exact format JCS specifies.
 * - Whitespace: none. Pure structural separators only.
 *
 * If we ever add user-controllable string content with non-BMP characters or
 * strange numeric edge cases (NaN, Infinity, -0), revisit and switch to a
 * full RFC 8785 implementation. For the Zynd envelope shape these can't
 * occur — the schema doesn't allow them.
 *
 * Public API:
 *   canonicalJson(obj): string  — produces the canonical UTF-8 byte
 *                                 representation, returned as a string.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null || v === undefined) return "null";

  if (typeof v === "boolean") return v ? "true" : "false";

  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`canonicalJson: non-finite number not representable: ${v}`);
    }
    // Normalize -0 to 0 for stable canonical form.
    if (Object.is(v, -0)) return "0";
    return JSON.stringify(v);
  }

  if (typeof v === "string") return JSON.stringify(v);

  if (Array.isArray(v)) {
    const items = v.map((item) => serialize(item));
    return "[" + items.join(",") + "]";
  }

  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    // UTF-16 code unit sort — matches what RFC 8785 mandates and what
    // every JS engine does for property iteration when keys are explicit
    // strings (not integer-like).
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out = entries.map(([k, val]) => JSON.stringify(k) + ":" + serialize(val));
    return "{" + out.join(",") + "}";
  }

  throw new Error(`canonicalJson: unsupported value type: ${typeof v}`);
}

/**
 * Encode a canonical JSON string as UTF-8 bytes — the actual input most
 * signing primitives expect.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
