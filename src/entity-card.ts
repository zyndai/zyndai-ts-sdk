/**
 * Removed.
 *
 * The legacy entity-card builder has been replaced by the A2A-shaped card
 * builder in `src/a2a/card.ts`. See `agent-dns/ideas/zynd-a2a-communication.md`.
 *
 * Migration:
 *   - buildEntityCard(opts)        → buildAgentCard(opts) from a2a/card.ts
 *   - signEntityCard(card, kp)     → signAgentCard(card, kp) from a2a/card.ts
 *   - canonicalJson(obj)           → canonicalJson(obj) from a2a/canonical.ts
 *   - buildEndpoints(baseUrl)      → no longer used (A2A has a single `url`)
 *
 * The new card is published at /.well-known/agent-card.json (was: agent.json).
 */

export const _LEGACY_ENTITY_CARD_REMOVED = true;
