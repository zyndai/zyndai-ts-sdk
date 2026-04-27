"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var index_js_1 = require("../src/index.js");
var config = {
    name: "Echo Agent",
    description: "Echoes back whatever you send",
    capabilities: { text: ["echo"] },
    registryUrl: "https://registry.zynd.ai",
    webhookPort: 5001,
    price: "$0.01",
};
var agent = new index_js_1.ZyndAIAgent(config);
agent.setCustomAgent(function (input) {
    return "Echo: ".concat(input);
});
agent.webhook.addMessageHandler(function (msg) {
    var result = "Echo: ".concat(msg.content);
    agent.webhook.setResponse(msg.messageId, result);
});
await agent.start();
console.log("Agent running. Press Ctrl+C to stop.");
