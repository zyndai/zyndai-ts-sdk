// Run with: node examples/simple-service.js  (after `pnpm build`)
//   or:    npx tsx examples/simple-service.ts
//
// registryUrl defaults to https://dns01.zynd.ai. service_endpoint defaults
// to entityUrl; override only when publishing a tunnel/proxy URL.
const { ZyndService } = require("../dist/index.js");

(async () => {
  const service = new ZyndService({
    name: "Text Transform Service",
    description: "Transforms text to uppercase",
    capabilities: { text: ["transform"] },
    webhookPort: 5002,
  });

  service.setHandler((input) => input.toUpperCase());

  await service.start();
  console.log("Service running. Press Ctrl+C to stop.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
