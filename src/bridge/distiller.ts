import { sanitizeString } from "./redactor.js";

// Tier 0: public agent card (role, bio, public skills)
// Tier 1: discovery assertions (experience, expertise, location — for matching)
// Tier 2: gated collaboration (contact details, work history with names)
// Tier 3: strictly local (shell commands, file paths, private notes)
export type PrivacyTier = 0 | 1 | 2 | 3;

export interface TieredAssertion {
  predicate: string;
  object: string;
  tier: PrivacyTier;
  source: string;
}

// Tier 3 triggers — content that must never leave local store
const TIER3_PATTERNS = [
  /\$\s+[a-z]/i,                          // shell commands
  /\b(?:sudo|chmod|chown|rm\s+-rf)\b/i,   // destructive shell ops
  /\/(?:Users|home|root|etc|var|tmp)\//,   // POSIX paths
  /[A-Za-z]:\\/,                          // Windows paths
  /private|confidential|secret|internal/i,
  /meeting notes|todo|action item/i,
];

// Tier 0 triggers — clearly public self-description
const TIER0_PREDICATES = new Set([
  "has_role",
  "has_title",
  "is_founder_of",
  "bio",
  "website",
  "linkedin_url",
  "twitter_handle",
]);

// Tier 1 triggers — useful for discovery/matching, not sensitive
const TIER1_PATTERNS = [
  /\b(?:engineer|developer|designer|researcher|founder|cto|ceo|coo|vp|director|manager)\b/i,
  /\b(?:python|typescript|rust|golang|solidity|react|node\.?js)\b/i,
  /\b(?:machine learning|ai|blockchain|web3|defi|crypto|fintech|saas)\b/i,
  /\b(?:san francisco|new york|london|berlin|singapore|remote)\b/i,
  /\b(?:open to|looking for|seeking|available for)\b/i,
  /expertise_in|skill|specializes|focuses on/i,
];

// Tier 2 triggers — personal but shareable under consent
const TIER2_PATTERNS = [
  /@[a-zA-Z0-9.]+/,                       // social handles / emails after redaction
  /\b(?:worked at|formerly|ex-|alumni)\b/i,
  /\b(?:university|college|school|degree|phd|mba)\b/i,
];

export function classifyTier(predicate: string, object: string): PrivacyTier {
  const combined = `${predicate} ${object}`;

  for (const pattern of TIER3_PATTERNS) {
    if (pattern.test(combined)) return 3;
  }

  if (TIER0_PREDICATES.has(predicate)) return 0;

  for (const pattern of TIER1_PATTERNS) {
    if (pattern.test(combined)) return 1;
  }

  for (const pattern of TIER2_PATTERNS) {
    if (pattern.test(combined)) return 2;
  }

  // Default: Tier 1 (discovery) for unknown assertions — can be manually upgraded/downgraded
  return 1;
}

export function distillLinkedInProfile(profile: {
  headline?: string;
  summary?: string;
  location?: string;
  experience?: Array<{ title?: string; company?: string; description?: string }>;
  skills?: string[];
  firstName?: string;
  lastName?: string;
}): TieredAssertion[] {
  const assertions: TieredAssertion[] = [];

  function push(predicate: string, raw: string, source: string): void {
    const object = sanitizeString(raw).trim();
    if (object.length < 3) return;
    const tier = classifyTier(predicate, object);
    assertions.push({ predicate, object, tier, source });
  }

  if (profile.headline) push("has_headline", profile.headline, "linkedin");
  if (profile.location) push("lives_in", profile.location, "linkedin");

  if (profile.summary) {
    const sentences = profile.summary.split(/[.\n]+/).filter((s) => s.trim().length > 15);
    for (const sentence of sentences.slice(0, 5)) {
      push("bio_excerpt", sentence, "linkedin");
    }
  }

  for (const exp of profile.experience ?? []) {
    if (exp.title) push("has_role", exp.title, "linkedin_experience");
    if (exp.company) push("worked_at", exp.company, "linkedin_experience");
    if (exp.description) push("work_description", exp.description.slice(0, 200), "linkedin_experience");
  }

  for (const skill of profile.skills ?? []) {
    push("expertise_in", skill, "linkedin_skills");
  }

  return assertions;
}
