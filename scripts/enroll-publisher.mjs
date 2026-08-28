import { webcrypto } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const siteUrl = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/u, "");
const code = process.env.PUBLISHER_ENROLLMENT_CODE ?? "";
const label = process.env.PUBLISHER_LABEL ?? "Hermes WebUI";
const publisherId = process.env.PUBLISHER_ID ?? "";
const keyPath = resolve(
  process.env.PUBLISHER_KEY_PATH ?? `${homedir()}/.config/hermes-webui/talaria-publisher.pem`,
);
if (!siteUrl || !code || !publisherId) {
  throw new Error("CONVEX_SITE_URL, PUBLISHER_ENROLLMENT_CODE, and PUBLISHER_ID are required");
}
const publisherUrl = new URL(publisherId);
if (!["http:", "https:"].includes(publisherUrl.protocol) || publisherUrl.origin !== publisherId) {
  throw new Error("PUBLISHER_ID must be the exact Hermes server origin configured in Talaria");
}

let privateKey;
let publicKey;
try {
  const pem = await readFile(keyPath, "utf8");
  const pkcs8 = Buffer.from(
    pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, ""),
    "base64",
  );
  privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
  publicKey = (await webcrypto.subtle.exportKey("jwk", privateKey)).x;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  privateKey = keys.privateKey;
  publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", keys.publicKey)).toString(
    "base64url",
  );
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", privateKey));
  const wrapped = pkcs8.toString("base64").match(/.{1,64}/gu)?.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await writeFile(keyPath, pem, { mode: 0o600, flag: "wx" });
  await chmod(keyPath, 0o600);
}
const response = await fetch(`${siteUrl}/v1/enrollments/publisher/redeem`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, label, publicKey, publisherId }),
});
const result = await response.json();
if (!response.ok) throw new Error(`publisher enrollment failed: ${JSON.stringify(result)}`);

console.log(`HERMES_WEBUI_TALARIA_RELAY_URL=${siteUrl}`);
console.log(`HERMES_WEBUI_TALARIA_PUBLISHER_ID=${result.publisherId}`);
console.log(`HERMES_WEBUI_TALARIA_KEY_ID=${result.keyId}`);
console.log(`HERMES_WEBUI_TALARIA_PRIVATE_KEY_PATH=${keyPath}`);
