/**
 * Distiller — fans out to all connected providers in parallel, merges results,
 * deduplicates facts and text blobs, then returns one unified DistillResult.
 *
 * Connector failures are logged but never abort the merge — partial results
 * from available connectors are always returned.
 */
import * as crypto from "node:crypto";
import type { CardUpdate, DistillResult, FactDecl, IMemoryConnector } from "./types.js";

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function mergeTextBlobs(blobs: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const blob of blobs) {
    const trimmed = blob.trim();
    if (!trimmed) continue;
    // Deduplicate sentences by content hash to avoid re-ingesting identical text
    const hash = contentHash(trimmed);
    if (!seen.has(hash)) {
      seen.add(hash);
      parts.push(trimmed);
    }
  }
  return parts.join(" ");
}

function deduplicateFacts(facts: FactDecl[]): FactDecl[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = `${f.predicate}::${f.value.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeCardEnrichment(updates: CardUpdate[]): CardUpdate {
  const capSet = new Set<string>();
  const tagSet = new Set<string>();
  let summary: string | undefined;

  for (const u of updates) {
    for (const cap of u.capabilities ?? []) {
      if (cap.trim()) capSet.add(cap.trim());
    }
    for (const tag of u.tags ?? []) {
      if (tag.trim()) tagSet.add(tag.trim());
    }
    if (u.summary && !summary) summary = u.summary;
  }

  return {
    capabilities: [...capSet].slice(0, 30),
    tags: [...tagSet].slice(0, 30),
    summary,
  };
}

export async function runDistiller(
  connectors: IMemoryConnector[]
): Promise<{
  result: DistillResult;
  connectorErrors: Record<string, string>;
}> {
  const settled = await Promise.allSettled(connectors.map((c) => c.distill()));
  const connectorErrors: Record<string, string> = {};

  const blobs: string[] = [];
  const allFacts: FactDecl[] = [];
  const allCardUpdates: CardUpdate[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    const connectorName = connectors[i]!.name;

    if (outcome.status === "rejected") {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      connectorErrors[connectorName] = reason;
      console.error(`[zynd/ctx] ${connectorName} distill failed: ${reason}`);
      continue;
    }

    blobs.push(outcome.value.textBlob);
    allFacts.push(...outcome.value.findabilityFacts);
    allCardUpdates.push(outcome.value.cardEnrichment);
  }

  return {
    result: {
      textBlob: mergeTextBlobs(blobs),
      findabilityFacts: deduplicateFacts(allFacts),
      cardEnrichment: mergeCardEnrichment(allCardUpdates),
    },
    connectorErrors,
  };
}
