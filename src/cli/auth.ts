import type { Command } from "commander";
import chalk from "chalk";
import { getRegistryUrl } from "./config.js";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Authentication commands");

  auth
    .command("login")
    .description("Authenticate with the ZyndAI registry")
    .action(() => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);
      const loginUrl = `${registryUrl}/auth/login`;

      console.log(chalk.bold("Browser-based authentication"));
      console.log();
      console.log(`  Open this URL to sign in:`);
      console.log(`  ${chalk.hex("#06B6D4")(loginUrl)}`);
      console.log();
      console.log(chalk.dim("  OAuth flow not yet implemented. Use keypair-based auth for now."));
    });

  auth
    .command("whoami")
    .description("Show current identity")
    .action(() => {
      const registryUrl = getRegistryUrl(program.opts().registry as string | undefined);
      console.log(chalk.dim("Registry:"), registryUrl);
      console.log(chalk.dim("Auth:"), "keypair-based (no OAuth session)");
    });
}
