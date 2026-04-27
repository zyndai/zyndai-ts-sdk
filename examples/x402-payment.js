// Run with: node examples/x402-payment.js  (after `pnpm build`)
const { X402PaymentProcessor, generateKeypair } = require("../dist/index.js");

const kp = generateKeypair();
const processor = new X402PaymentProcessor({
  ed25519PrivateKeyBytes: kp.privateKeyBytes,
});

console.log("ETH Address:", processor.address);
console.log("Entity ID:", kp.entityId);
console.log("Public Key:", kp.publicKeyString);
