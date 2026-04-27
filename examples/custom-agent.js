// Run with: node examples/custom-agent.js  (after `pnpm build`)
//   or:    npx tsx examples/custom-agent.ts
const { ZyndAIAgent } = require("../dist/index.js");

(async () => {
  const agent = new ZyndAIAgent({
    name: "Echo Agent",
    description: "Echoes back whatever you send",
    capabilities: { text: ["echo"] },
    webhookPort: 5001,
    price: "$0.01",
  });

  agent.setCustomAgent((input) => `Echo: ${input}`);

  agent.webhook.addMessageHandler(async (msg) => {
    const result = await agent.invoke(msg.content);
    agent.webhook.setResponse(msg.messageId, result);
  });

  await agent.start();
  console.log("Agent running. Press Ctrl+C to stop.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
