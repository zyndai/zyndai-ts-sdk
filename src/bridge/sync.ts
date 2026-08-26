import type { IMemoryConnector, MatchResult, SyncResult } from "./types.js";
import type { MemoryClient } from "./memory-client.js";
import type { UpdateEntityOpts } from "../registry.js";
import { updateEntity } from "../registry.js";
import { runDistiller } from "./connector-distiller.js";
import { drainToMemoryLayer } from "./outbox.js";
import type { Ed25519Keypair } from "../identity.js";

export interface SyncOpts {
  connectors: IMemoryConnector[];
  memoryClient: MemoryClient;
  agentId?: string;
  keypair?: Ed25519Keypair;
  registryUrl?: string;
  existingCapabilities?: string[];
  existingTags?: string[];
}

export async function sync(opts: SyncOpts): Promise<SyncResult> {
  const { connectors, memoryClient, agentId, keypair, registryUrl } = opts;

  if (connectors.length === 0) {
    return {
      factsWritten: 0,
      factsDeclared: 0,
      factsSkipped: 0,
      textBytes: 0,
      cardUpdated: false,
      connectorResults: {},
    };
  }

  // Step 1: Fan out to all connectors
  const { result, connectorErrors } = await runDistiller(connectors);
  const connectorResults: SyncResult["connectorResults"] = {};
  for (const [name, error] of Object.entries(connectorErrors)) {
    connectorResults[name] = { ok: false, error };
  }
  for (const connector of connectors) {
    if (!connectorResults[connector.name]) {
      connectorResults[connector.name] = { ok: true };
    }
  }

  // Step 2: Text → /ingest (private memory pipeline)
  let textBytes = 0;
  let factsWritten = 0;
  if (result.textBlob.length >= 40) {
    try {
      const ingestResult = await memoryClient.ingestText(result.textBlob);
      textBytes = result.textBlob.length;
      factsWritten = ingestResult.chunks_inserted;
    } catch (err) {
      console.error(`[zynd/bridge] ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: Structured facts → /me/findability/declare-batch (public card)
  let factsDeclared = 0;
  let factsSkipped = 0;
  if (result.findabilityFacts.length > 0) {
    try {
      const batchResult = await memoryClient.declareBatch(result.findabilityFacts);
      factsDeclared = batchResult.declared.length;
      factsSkipped = batchResult.skipped.length;
    } catch (err) {
      console.error(`[zynd/bridge] declare-batch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 4: AgentDNS card enrichment (only if agent is registered)
  let cardUpdated = false;
  if (agentId && keypair && registryUrl && result.cardEnrichment.capabilities.length > 0) {
    try {
      const mergedCaps = [
        ...new Set([...(opts.existingCapabilities ?? []), ...result.cardEnrichment.capabilities]),
      ].slice(0, 30);
      const mergedTags = [
        ...new Set([...(opts.existingTags ?? []), ...result.cardEnrichment.tags]),
      ].slice(0, 30);

      const updateOpts: UpdateEntityOpts = {
        registryUrl,
        entityId: agentId,
        keypair,
        fields: {
          capability_summary: { skills: mergedCaps },
          tags: mergedTags,
          ...(result.cardEnrichment.summary ? { summary: result.cardEnrichment.summary } : {}),
        },
      };
      await updateEntity(updateOpts);
      cardUpdated = true;
    } catch (err) {
      console.error(`[zynd/bridge] AgentDNS card update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 5: Drain outbox → declare-batch (structured assertions from LinkedIn distiller)
  // Uses the live /me/findability/declare-batch endpoint — no hard stop.
  try {
    const drained = await drainToMemoryLayer((facts) => memoryClient.declareBatch(facts));
    if (drained.sent > 0) {
      factsDeclared += drained.sent;
    }
  } catch (err) {
    console.error(`[zynd/bridge] outbox drain failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    factsWritten,
    factsDeclared,
    factsSkipped,
    textBytes,
    cardUpdated,
    connectorResults,
  };
}

export async function getMatches(
  memoryClient: MemoryClient,
  registryUrl: string,
  clusterType: "full_context" | "skill_cluster" | "intent_cluster" | "place_cluster" = "full_context",
  limit = 20
): Promise<MatchResult[]> {
  const matches = await memoryClient.getMatches(clusterType, limit);

  // Enrich each match with their AgentDNS card when agent_id is available
  const enriched = await Promise.allSettled(
    matches.map(async (match) => {
      if (!match.user_id) return match;
      // Try to fetch the AgentDNS card for this user (agent_id stored in memory-layer users table)
      // For now return the match as-is — enrichment can be added once we have the agent_id lookup
      return match;
    })
  );

  return enriched
    .filter((r): r is PromiseFulfilledResult<MatchResult> => r.status === "fulfilled")
    .map((r) => r.value);
}
