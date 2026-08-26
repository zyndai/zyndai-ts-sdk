import { loadStore, saveStore } from "./store.js";
import type { LinkedInGovernorState } from "./store.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const RATE_LIMIT_PER_HOUR = 15;
const RATE_LIMIT_PER_DAY = 100;

// Tools that the LinkedIn connector must never expose — PRD §6 deny list
export const LINKEDIN_DENY_LIST = new Set([
  "send_message",
  "get_inbox",
  "bulk_message",
  "export_connections",
  "scrape_profile",
]);

export interface GovernorStatus {
  enabled: boolean;
  hourRemaining: number;
  dayRemaining: number;
  cooldownUntil: Date | null;
  blocked: boolean;
}

function resetHourWindowIfStale(state: LinkedInGovernorState, now: number): void {
  if (now - state.windowStart > HOUR_MS) {
    state.windowStart = now;
    state.hourCount = 0;
  }
}

function resetDayWindowIfStale(state: LinkedInGovernorState, now: number): void {
  if (now - state.dayWindowStart > DAY_MS) {
    state.dayWindowStart = now;
    state.dayCount = 0;
  }
}

/** Check if a fetch is currently allowed and consume quota if yes. */
export async function acquireRateSlot(): Promise<void> {
  const store = await loadStore();
  const state = store.linkedin;
  const now = Date.now();

  // Cooldown check (429, auth failure, or CAPTCHA)
  if (state.cooldownUntil && now < state.cooldownUntil) {
    const until = new Date(state.cooldownUntil).toISOString();
    throw new Error(`ERR_LINKEDIN_COOLDOWN: rate limited until ${until}`);
  }

  resetHourWindowIfStale(state, now);
  resetDayWindowIfStale(state, now);

  if (state.hourCount >= RATE_LIMIT_PER_HOUR) {
    const resetAt = new Date(state.windowStart + HOUR_MS).toISOString();
    throw new Error(`ERR_LINKEDIN_RATE_LIMIT: hour quota (${RATE_LIMIT_PER_HOUR}) exceeded. Resets at ${resetAt}`);
  }

  if (state.dayCount >= RATE_LIMIT_PER_DAY) {
    const resetAt = new Date(state.dayWindowStart + DAY_MS).toISOString();
    throw new Error(`ERR_LINKEDIN_RATE_LIMIT: day quota (${RATE_LIMIT_PER_DAY}) exceeded. Resets at ${resetAt}`);
  }

  state.hourCount++;
  state.dayCount++;
  await saveStore(store);
}

/**
 * Engage cooldown on 429, auth checkpoint, or CAPTCHA.
 * durationMs defaults to 1 hour.
 */
export async function engageCooldown(durationMs = HOUR_MS): Promise<void> {
  const store = await loadStore();
  store.linkedin.cooldownUntil = Date.now() + durationMs;
  await saveStore(store);
}

export async function getGovernorStatus(): Promise<GovernorStatus> {
  const store = await loadStore();
  const state = store.linkedin;
  const now = Date.now();

  resetHourWindowIfStale(state, now);
  resetDayWindowIfStale(state, now);

  const inCooldown = Boolean(state.cooldownUntil && now < state.cooldownUntil);
  const hourExceeded = state.hourCount >= RATE_LIMIT_PER_HOUR;
  const dayExceeded = state.dayCount >= RATE_LIMIT_PER_DAY;

  return {
    enabled: true,
    hourRemaining: Math.max(0, RATE_LIMIT_PER_HOUR - state.hourCount),
    dayRemaining: Math.max(0, RATE_LIMIT_PER_DAY - state.dayCount),
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil) : null,
    blocked: inCooldown || hourExceeded || dayExceeded,
  };
}

/** Filter a tool list against the deny list — returns only allowed tools. */
export function filterAllowedTools(tools: string[]): string[] {
  return tools.filter((t) => !LINKEDIN_DENY_LIST.has(t));
}
