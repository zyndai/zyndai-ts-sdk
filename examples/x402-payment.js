"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var index_js_1 = require("../src/index.js");
var kp = (0, index_js_1.generateKeypair)();
var processor = new index_js_1.X402PaymentProcessor({
    ed25519PrivateKeyBytes: kp.privateKeyBytes,
});
console.log("ETH Address:", processor.address);
console.log("Entity ID:", kp.entityId);
console.log("Public Key:", kp.publicKeyString);
