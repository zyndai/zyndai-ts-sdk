/**
 * `zynd init` was removed.
 *
 * Developer identities are issued exclusively by the registry now —
 * organizations running a registry mint keypairs via the browser
 * onboarding flow. To create or refresh your developer identity:
 *
 *   zynd auth login --registry https://your-registry.example.com
 *
 * The registry walks you through OAuth, generates an Ed25519 keypair on
 * the server, and ships the encrypted private key back to your local
 * `~/.zynd/developer.json`. After that, every subsequent CLI command
 * picks up that registry as the default home.
 *
 * This file is kept only so any stale import of `registerInitCommand`
 * fails with a useful message instead of a cryptic resolution error.
 */

export function registerInitCommand(): void {
  throw new Error(
    "`zynd init` has been removed. Use `zynd auth login --registry <url>` " +
      "to create your developer identity through your registry's onboarding flow.",
  );
}
