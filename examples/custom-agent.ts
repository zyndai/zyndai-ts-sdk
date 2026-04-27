import { ZyndAIAgent, type AgentConfig } from "../src/index.js";

// registryUrl defaults to https://dns01.zynd.ai (override via env or here).
const config: AgentConfig = {
  name: "Echo Agent",
  description: "Echoes back whatever you send",
  capabilities: { text: ["echo"] },
  webhookPort: 5001,
  price: "$0.01",
};

const agent = new ZyndAIAgent(config);

agent.setCustomAgent((input: string) => `Echo: ${input}`);

// Wire incoming webhook messages through the agent's framework dispatcher
// so setCustomAgent / setLangchainAgent / etc. all behave the same way.
agent.webhook.addMessageHandler(async (msg) => {
  const result = await agent.invoke(msg.content);
  agent.webhook.setResponse(msg.messageId, result);
});

await agent.start();
console.log("Agent running. Press Ctrl+C to stop.");
