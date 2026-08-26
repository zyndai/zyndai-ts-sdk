import type { PrivacyTier } from "./distiller.js";

// ─── Pattern groups (10 layers, PRD §4) ──────────────────────────────────────

// Layer 1: API keys / tokens
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]"],
  [/ghp_[A-Za-z0-9]{36}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/gho_[A-Za-z0-9]{36}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{82}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/xox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]"],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer [REDACTED_BEARER_TOKEN]"],
];

// Layer 2: JWTs
const JWT_PATTERN: [RegExp, string] = [
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  "[REDACTED_JWT_TOKEN]",
];

// Layer 3: Private key blocks
const PRIVATE_KEY_BLOCK: [RegExp, string] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  "[REDACTED_PRIVATE_KEY_BLOCK]",
];

// Layer 4: PII
const PII_PATTERNS: Array<[RegExp, string]> = [
  // Email before generic URL so credentials get caught first
  [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]"],
  // E.164 phone numbers (international + US formats)
  [/(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g, "[REDACTED_PHONE_E164]"],
];

// Layer 5: LinkedIn URNs (contact identifiers)
const URN_PATTERN: [RegExp, string] = [
  /urn:li:(?:person|member|company|school):[A-Za-z0-9_-]+/g,
  "[REDACTED_CONTACT_URN]",
];

// Layer 6: Cookies (li_at, JSESSIONID, session tokens)
const COOKIE_PATTERNS: Array<[RegExp, string]> = [
  [/li_at=[A-Za-z0-9._%-]+/g, "li_at=[REDACTED_COOKIE_TOKEN]"],
  [/JSESSIONID=[A-Za-z0-9":%._-]+/g, "JSESSIONID=[REDACTED_COOKIE_TOKEN]"],
  [/(?:session|auth|token|csrf)[-_]?(?:token|key|id|secret)=[^\s&;",]+/gi, "[REDACTED_COOKIE_TOKEN]"],
];

// Layer 7: URLs with credentials
const URL_PATTERNS: Array<[RegExp, string]> = [
  // Basic-auth credentials in URL: https://user:pass@host
  [/https?:\/\/[^:@\s]+:[^@\s]+@[^\s]*/g, "[REDACTED_URL_CREDENTIALS]"],
  // Sensitive query params: token=, key=, secret=, password=, api_key=
  [/([?&](?:token|key|secret|password|api_key|access_token|refresh_token|client_secret)=)[^\s&"',]*/gi, "$1[REDACTED]"],
];

// Layer 8: File system paths
const PATH_PATTERNS: Array<[RegExp, string]> = [
  // POSIX absolute paths (avoid mangling simple slugs: must contain / after first char)
  [/\/(?:Users|home|root|etc|var|tmp|opt|usr)\/[^\s"',;>]+/g, "[REDACTED_POSIX_PATH]"],
  // Windows absolute paths
  [/[A-Za-z]:\\[^\s"',;>]+/g, "[REDACTED_WINDOWS_PATH]"],
];

// Layer 9: HTML tags (raw HTML should never leave the system)
const HTML_PATTERN: [RegExp, string] = [
  /<\/?[a-zA-Z][^>]*>/g,
  "[REDACTED_RAW_HTML_TAGS]",
];

// Layer 10: Sensitive object key names (applied during object scan)
const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apiKey",
  "private_key",
  "privateKey",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "client_secret",
  "clientSecret",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "li_at",
  "jsessionid",
]);

// ─── String sanitizer ─────────────────────────────────────────────────────────

export function sanitizeString(input: string): string {
  let s = input;

  s = s.replace(...PRIVATE_KEY_BLOCK);
  s = s.replace(...JWT_PATTERN);

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of COOKIE_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of URL_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of PII_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  s = s.replace(...URN_PATTERN);
  for (const [pattern, replacement] of PATH_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  s = s.replace(...HTML_PATTERN);

  return s;
}

// ─── Object sanitizer ─────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function sanitizeObject(input: JsonValue): JsonValue {
  if (input === null || typeof input !== "object") {
    if (typeof input === "string") return sanitizeString(input);
    return input;
  }

  if (Array.isArray(input)) {
    return input.map(sanitizeObject);
  }

  const result: { [k: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeObject(value as JsonValue);
    }
  }
  return result;
}

// ─── Egress gate ─────────────────────────────────────────────────────────────

const EGRESS_LEAK_PATTERNS = [
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  /\/(?:Users|home|root|etc|var|tmp|opt|usr)\//,
  /[A-Za-z]:\\/,
  /sk-proj-|sk-ant-api|AKIA[0-9A-Z]/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/,
  /eyJ[A-Za-z0-9_-]+\.eyJ/,
  /li_at=AQED/,
];

export function assertEgressClean(payload: string, tier: PrivacyTier): void {
  // Tier 3 must never reach egress — caller error
  if (tier === 3) {
    throw new Error("ERR_EGRESS_POLICY_VIOLATION: Tier 3 data must not be synced");
  }

  for (const pattern of EGRESS_LEAK_PATTERNS) {
    if (pattern.test(payload)) {
      throw new Error(
        `ERR_EGRESS_POLICY_VIOLATION: payload contains sensitive pattern (${pattern.source.slice(0, 40)})`
      );
    }
  }
}
