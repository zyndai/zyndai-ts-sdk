"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var index_js_1 = require("../src/index.js");
var config = {
    name: "Text Transform Service",
    description: "Transforms text to uppercase",
    capabilities: { text: ["transform"] },
    registryUrl: "https://registry.zynd.ai",
    webhookPort: 5002,
};
var service = new index_js_1.ZyndService(config);
service.setHandler(function (input) {
    return input.toUpperCase();
});
await service.start();
console.log("Service running. Press Ctrl+C to stop.");
