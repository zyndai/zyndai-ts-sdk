import { ZyndService, type ServiceConfig } from "../src/index.js";

// registryUrl defaults to https://dns01.zynd.ai. Override here or via
// ZYND_REGISTRY_URL if you're pointing at a private registry.
//
// service_endpoint defaults to entityUrl when unset, which is what you want
// unless you're publishing a tunnel/proxy URL different from the local
// webhook (e.g., ngrok). Set ServiceConfig.serviceEndpoint to override.
const config: ServiceConfig = {
  name: "Text Transform Service",
  description: "Transforms text to uppercase",
  capabilities: { text: ["transform"] },
  webhookPort: 5002,
};

const service = new ZyndService(config);

service.setHandler((input: string) => input.toUpperCase());

await service.start();
console.log("Service running. Press Ctrl+C to stop.");
