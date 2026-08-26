/**
 * LinkedIn setup helpers — opens the user's default browser (Arc, Safari,
 * Firefox, Chrome, whatever) and reads li_at from its cookie store via rookiepy.
 * No browser forced, no binary downloaded, no password stored.
 */
import chalk from "chalk";
import { LinkedInConnector, type LinkedInAuthResult } from "../ctx/connectors/linkedin.js";

/** Returns true if LinkedIn li_at is stored in config. */
export function linkedInSessionExists(liAt: string | undefined): boolean {
  return typeof liAt === "string" && liAt.length > 0;
}

/**
 * Opens system Chrome for LinkedIn login. Returns li_at + jsessionid.
 * Works with Google OAuth, email/password, SSO — any login method.
 */
export async function openLinkedInBrowserAuth(): Promise<LinkedInAuthResult> {
  return LinkedInConnector.openBrowserAuth();
}

/** Interactive re-auth for zynd ctx linkedin-auth command. */
export async function promptLinkedInBrowserAuth(): Promise<LinkedInAuthResult> {
  console.log(chalk.bold("\nLinkedIn authentication\n"));
  console.log(chalk.dim("  Opening LinkedIn in your default browser — log in with any method...\n"));
  try {
    const result = await openLinkedInBrowserAuth();
    return result;
  } catch (err) {
    throw new Error(
      `LinkedIn auth failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
