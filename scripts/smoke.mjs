import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";

const siteUrl = process.env.CONVEX_SITE_URL;
const publisherCode = process.env.PUBLISHER_ENROLLMENT_CODE;
const deviceCode = process.env.DEVICE_ENROLLMENT_CODE;
assert(siteUrl, "CONVEX_SITE_URL is required");
assert(publisherCode, "PUBLISHER_ENROLLMENT_CODE is required");
assert(deviceCode, "DEVICE_ENROLLMENT_CODE is required");

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function jsonRequest(path, init) {
  const response = await fetch(`${siteUrl}${path}`, init);
  const body = await response.json();
  assert(response.ok, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function signedPublisherRequest(path, body, keyId, privateKey) {
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = webcrypto.randomUUID();
  const bodyHash = base64Url(
    await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );
  const signingInput = ["PUT", path, timestamp, nonce, bodyHash].join("\n");
  const signature = base64Url(
    await webcrypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(signingInput)),
  );
  const response = await fetch(`${siteUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-talaria-key-id": keyId,
      "x-talaria-timestamp": timestamp,
      "x-talaria-nonce": nonce,
      "x-talaria-signature": signature,
    },
    body: payload,
  });
  return { response, body: await response.json() };
}

const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicKey = base64Url(await webcrypto.subtle.exportKey("raw", keys.publicKey));
const publisher = await jsonRequest("/v1/enrollments/publisher/redeem", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: publisherCode, label: "Smoke Hermes", publicKey }),
});
const device = await jsonRequest("/v1/enrollments/device/redeem", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: deviceCode, label: "Smoke iPhone" }),
});

await jsonRequest(`/v1/devices/${device.deviceId}`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${device.credential}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    label: "Smoke iPhone",
    bundleId: "dev.kil.talaria",
    apsEnvironment: "sandbox",
    preferences: {
      liveActivitiesEnabled: true,
      notificationsEnabled: false,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  }),
});

const sessionId = "smoke-session";
const activityPath = `/v1/publishers/${publisher.publisherId}/sessions/${sessionId}/activity`;
const now = Date.now();
const publishBody = {
  eventId: "smoke-event-1",
  revision: 1,
  state: {
    sessionId,
    streamId: "smoke-stream",
    title: "Smoke test",
    phase: "running",
    updatedAt: now,
    deepLink: `/sessions/${sessionId}`,
  },
};
const accepted = await signedPublisherRequest(
  activityPath,
  publishBody,
  publisher.keyId,
  keys.privateKey,
);
assert.equal(accepted.response.status, 200);
assert.equal(accepted.body.status, "accepted");
const duplicate = await signedPublisherRequest(
  activityPath,
  publishBody,
  publisher.keyId,
  keys.privateKey,
);
assert.equal(duplicate.response.status, 200);
assert.equal(duplicate.body.status, "duplicate");
const stale = await signedPublisherRequest(
  activityPath,
  { ...publishBody, eventId: "smoke-event-stale", revision: 0 },
  publisher.keyId,
  keys.privateKey,
);
assert.equal(stale.response.status, 409);
assert.equal(stale.body.status, "stale");

const snapshot = await jsonRequest("/v1/activity-snapshot?mode=all_running", {
  headers: {
    authorization: `Bearer ${device.credential}`,
    "x-talaria-device-id": device.deviceId,
  },
});
assert(snapshot.aggregate.activeCount >= 1);
assert(snapshot.aggregate.rows.some((row) => row.sessionId === sessionId));

if (process.env.SMOKE_REGISTER_ACTIVITY === "1") {
  await jsonRequest(`/v1/devices/${device.deviceId}/live-activities/smoke-activity`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${device.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "smoke-activity-token",
    }),
  });
}

console.log(
  JSON.stringify(
    {
      publisherId: publisher.publisherId,
      deviceId: device.deviceId,
      aggregate: snapshot.aggregate,
    },
    null,
    2,
  ),
);
