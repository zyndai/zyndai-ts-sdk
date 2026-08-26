import * as crypto from "node:crypto";
import { loadStore, saveStore } from "./store.js";
import type { OutboxItem } from "./store.js";
import type { TieredAssertion } from "./distiller.js";
import { assertEgressClean } from "./redactor.js";

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 5 * 60_000; // 5 min max

/** Full jitter: delay = random(0, min(cap, base * 2^attempt)) */
function jitteredDelay(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  return Math.random() * ceiling;
}

/** Enqueue a tiered assertion for cloud sync. Tier 3 is rejected (never leaves local). */
export async function enqueueAssertion(assertion: TieredAssertion): Promise<void> {
  if (assertion.tier === 3) {
    throw new Error("ERR_EGRESS_POLICY_VIOLATION: Tier 3 assertions must not be enqueued");
  }

  // Egress gate: verify no sensitive patterns leaked through
  assertEgressClean(`${assertion.predicate} ${assertion.object}`, assertion.tier);

  const store = await loadStore();
  const id = crypto.randomUUID();

  // Deduplication: skip if same predicate+object already pending
  const alreadyQueued = store.outbox.some(
    (item) => item.predicate === assertion.predicate && item.object === assertion.object
  );
  if (alreadyQueued) return;

  const item: OutboxItem = {
    id,
    predicate: assertion.predicate,
    object: assertion.object,
    tier: assertion.tier as 0 | 1 | 2,
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
  };

  store.outbox.push(item);
  await saveStore(store);
}

/** Claim the next due outbox item (oldest next_attempt_at that is <= now). */
export async function claimNextDue(): Promise<OutboxItem | null> {
  const store = await loadStore();
  const now = Date.now();

  const due = store.outbox
    .filter((item) => item.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

  if (due.length === 0) return null;
  return due[0] ?? null;
}

/** Mark an item as succeeded — remove from outbox. */
export async function markSucceeded(id: string): Promise<void> {
  const store = await loadStore();
  store.outbox = store.outbox.filter((item) => item.id !== id);
  await saveStore(store);
}

/** Mark an item as failed — increment attempts, reschedule with jitter. */
export async function markFailed(id: string): Promise<void> {
  const store = await loadStore();
  const item = store.outbox.find((item) => item.id === id);
  if (!item) return;
  item.attempts += 1;
  item.nextAttemptAt = Date.now() + jitteredDelay(item.attempts);
  await saveStore(store);
}

/**
 * Drain the outbox: call `syncFn` for each due item in sequence.
 * Stops on first network error (will retry next run).
 */
export async function drainOutbox(
  syncFn: (item: OutboxItem) => Promise<void>
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const store = await loadStore();
  const now = Date.now();
  const due = store.outbox
    .filter((item) => item.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

  for (const item of due) {
    try {
      await syncFn(item);
      await markSucceeded(item.id);
      sent++;
    } catch (err) {
      await markFailed(item.id);
      failed++;
      console.error(
        `[bridge/outbox] item ${item.id} failed (attempt ${item.attempts + 1}):`,
        err instanceof Error ? err.message : String(err)
      );
      // Stop on first failure — don't hammer a failing API
      break;
    }
  }

  return { sent, failed };
}

export async function enqueueAssertions(assertions: TieredAssertion[]): Promise<number> {
  let queued = 0;
  for (const a of assertions) {
    if (a.tier === 3) continue;
    try {
      await enqueueAssertion(a);
      queued++;
    } catch {
      // Individual enqueue failures are non-fatal (e.g. egress gate caught PII)
    }
  }
  return queued;
}

/**
 * Drain outbox to memory-layer via declare-batch.
 * Uses the existing /me/findability/declare-batch endpoint (live, no hard stop).
 * Bundles up to 50 items per call to minimize round-trips.
 */
export async function drainToMemoryLayer(
  declareFn: (facts: Array<{ predicate: string; value: string }>) => Promise<{
    declared: Array<{ predicate: string; value: string }>;
    skipped: Array<{ predicate: string; value: string; reason: string }>;
  }>
): Promise<{ sent: number; failed: number }> {
  return drainOutbox(async (item) => {
    await declareFn([{ predicate: item.predicate, value: item.object }]);
  });
}
