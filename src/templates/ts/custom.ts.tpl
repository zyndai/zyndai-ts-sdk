/**
 * __AGENT_NAME__ — Custom Agent on the Zynd network (A2A protocol).
 *
 * Install dependencies:
 *   npm install zyndai
 *
 * Run:
 *   npx tsx agent.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import {
  ZyndAIAgent,
  AgentConfigSchema,
  resolveRegistryUrl,
  type HandlerInput,
  type TaskHandle,
} from "zyndai";

import { RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES } from "./payload.js";

const _config: Record<string, any> = fs.existsSync("agent.config.json")
  ? JSON.parse(fs.readFileSync("agent.config.json", "utf-8"))
  : {};

async function main() {
  // The card's `provider`, `defaultInputModes`, `defaultOutputModes`,
  // `input_schema`, `output_schema`, and a default `skills[]` entry are all
  // auto-derived at runtime (provider from your developer keypair + the
  // registry; the rest from the Zod schemas in payload.ts). You only need
  // to add fields here when you want to override the defaults.
  const agentConfig = AgentConfigSchema.parse({
    name: _config.name ?? "__AGENT_NAME__",
    description:
      _config.description ?? "__AGENT_NAME__ — a custom agent on the Zynd network.",
    version: _config.version ?? "0.1.0",
    category: _config.category ?? "general",
    tags: _config.tags ?? [],
    serverHost: _config.server_host ?? "0.0.0.0",
    serverPort: Number(process.env.ZYND_SERVER_PORT ?? _config.server_port ?? 5000),
    authMode: _config.auth_mode ?? "permissive",
    registryUrl: resolveRegistryUrl({ fromConfigFile: _config.registry_url }),
    keypairPath: process.env.ZYND_AGENT_KEYPAIR_PATH ?? _config.keypair_path,
    entityUrl: process.env.ZYND_ENTITY_URL ?? _config.entity_url,
    price: _config.price,
    entityPricing: _config.entity_pricing ?? undefined,
    entityIndex: _config.entity_index ?? 0,
    // Optional advanced overrides — uncomment to set explicitly:
    // skills: _config.skills,
    // fqan: _config.fqan,
    // iconUrl: _config.icon_url,
    // documentationUrl: _config.documentation_url,
  });

  const agent = new ZyndAIAgent(agentConfig, {
    payloadModel: RequestPayload,
    outputModel: ResponsePayload,
    maxBodyBytes: MAX_FILE_SIZE_BYTES,
  });

  // Full-control handler. Receives the verified inbound message + a TaskHandle
  // for streaming progress, asking for clarification, or completing the task.
  agent.onMessage(async (input: HandlerInput, task: TaskHandle) => {
    // input.payload is validated against RequestPayload (when supplied).
    // input.attachments holds any file/image/audio/video parts the caller sent.
    // input.signed tells you whether the caller's x-zynd-auth verified.
    const prompt = input.message.content;

    // Example: ask for clarification when a required field is missing.
    // const followup = await task.ask("Which language should I translate to?");
    // const langChoice = followup.payload.target_language;

    // Example: stream progress updates.
    // await task.update("working", { text: "Thinking..." });

    // Run your real logic here.
    const response = `Hello from __AGENT_NAME__! You asked: ${prompt}`;

    // Return a string, an object matching ResponsePayload, or any payload —
    // task.complete is invoked automatically with the return value.
    return { response };
  });

  await agent.start();

  console.log(`\n__AGENT_NAME__ is running`);
  console.log(`A2A endpoint: ${agent.a2aUrl}`);
  console.log(`Agent card:   ${agent.cardUrl}`);

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  if (process.stdin.isTTY) {
    console.log("Type 'exit' to quit\n");
    process.stdin.on("data", (buf) => {
      if (buf.toString().trim().toLowerCase() === "exit") process.exit(0);
    });
  } else {
    await new Promise<never>(() => {});
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`Error: ${String(err)}`);
  }
  process.exit(1);
});
