/**
 * One-off diagnostic (safe: never prints the key itself).
 * Runs inside the worker container:
 *   sudo docker cp inspect-key.js probot-prreviewautomation-u5crir-worker-1:/tmp/inspect-key.js
 *   sudo docker exec probot-prreviewautomation-u5crir-worker-1 node /tmp/inspect-key.js
 */
const raw = process.env.GITHUB_PRIVATE_KEY_BASE64 || "";
console.log("raw length:", raw.length);
const b64 = raw.replace(/\s+/g, "");
const pem = Buffer.from(b64, "base64").toString("utf8");
console.log("decoded length:", pem.length);
console.log("first 30 chars (json-escaped):", JSON.stringify(pem.slice(0, 30)));
console.log("last 20 chars (json-escaped):", JSON.stringify(pem.slice(-20)));
console.log(
  "contains CR:",
  pem.includes("\r"),
  "| starts with BOM:",
  pem.charCodeAt(0) === 0xfeff,
  "| contains backslash:",
  pem.includes("\\"),
  "| contains quote:",
  pem.includes('"') || pem.includes("'"),
);
try {
  const crypto = require("crypto");
  const key = crypto.createPrivateKey(pem);
  console.log("key parse: OK, type:", key.asymmetricKeyType);
} catch (e) {
  console.log("key parse FAILED:", e.message);
}
