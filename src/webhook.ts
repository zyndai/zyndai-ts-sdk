/**
 * Removed.
 *
 * The legacy `WebhookCommunicationManager` has been deleted as part of the
 * A2A migration. Communication now flows through the A2A server in
 * `src/a2a/server.ts`. See `agent-dns/ideas/zynd-a2a-communication.md`.
 *
 * This file is kept as a stub solely so any stray imports break loudly
 * with a meaningful message rather than fail with cryptic resolution
 * errors. Update your code:
 *
 *   - WebhookCommunicationManager → A2AServer (in `a2a/server.ts`)
 *   - agent.webhook.addMessageHandler(fn) → agent.onMessage((input, task) => ...)
 *   - agent.webhook.setResponse(id, x)    → return value or task.complete(x)
 *   - /webhook, /webhook/sync             → /a2a/v1
 *   - /.well-known/agent.json             → /.well-known/agent-card.json
 */

export const _LEGACY_WEBHOOK_REMOVED = true;
