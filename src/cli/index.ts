import { Command } from "commander";
import { version as pkgVersion } from "../../package.json";
import { registerInitCommand } from "./init.js";
import { registerKeysCommand } from "./keys.js";
import { registerSearchCommand } from "./search.js";
import { registerRegisterCommand } from "./register.js";
import { registerCardCommand } from "./card.js";
import { registerDeregisterCommand } from "./deregister.js";
import { registerStatusCommand } from "./status.js";
import { registerInfoCommand } from "./info.js";
import { registerResolveCommand } from "./resolve.js";
import { registerAuthCommand } from "./auth.js";
import { registerAgentCommand } from "./agent.js";
import { registerServiceCommand } from "./service.js";

const program = new Command();

program
  .name("zynd")
  .description("ZyndAI Agent SDK CLI")
  .version(pkgVersion)
  .option("--registry <url>", "Registry URL override");

registerInitCommand(program);
registerKeysCommand(program);
registerSearchCommand(program);
registerRegisterCommand(program);
registerCardCommand(program);
registerDeregisterCommand(program);
registerStatusCommand(program);
registerInfoCommand(program);
registerResolveCommand(program);
registerAuthCommand(program);
registerAgentCommand(program);
registerServiceCommand(program);

program.parse();
