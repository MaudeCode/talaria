# Relay HTTP API v1

All bodies are JSON. User-authenticated routes use `Authorization: Bearer <relay session token>`.

## Apple sign-in

`POST /v1/auth/apple`

```json
{
  "identityToken": "Apple identity JWT",
  "nonce": "SHA-256 nonce sent in the Apple authorization request"
}
```

The relay verifies the ES256 signature against Apple's JWKS plus issuer, audience, expiry, nonce, and token replay. It returns an opaque 30-day relay session token. End it with `DELETE /v1/auth/session`.

## Automatic Hermes pairing

Talaria creates a ten-minute invitation with authenticated `POST /v1/pairings/publisher` and passes it through the authenticated Hermes API.

Hermes generates an Ed25519 key locally and redeems the invitation once:

`POST /v1/pairings/publisher/redeem`

```json
{
  "invitation": "one-time invitation",
  "publisherId": "https://hermes.example.com",
  "label": "Home Hermes",
  "publicKey": "base64url raw Ed25519 public key"
}
```

The private key never leaves the Hermes machine.

## Publisher authentication

Publisher requests include:

```text
X-Talaria-Key-Id
X-Talaria-Timestamp    Unix seconds, at most five minutes from relay time
X-Talaria-Nonce        Unique per request
X-Talaria-Signature    Base64url Ed25519 signature
```

The signed UTF-8 bytes are:

```text
METHOD
PATH
TIMESTAMP
NONCE
BASE64URL_SHA256_OF_EXACT_BODY
```

## Publish a complete snapshot

`PUT /v1/publishers/{publisherId}/snapshot`

```json
{
  "snapshotId": "stable-snapshot-id",
  "states": [
    {
      "sessionId": "session-id",
      "streamId": "optional-stream-id",
      "eventId": "stable-event-id",
      "revision": 42,
      "title": "Bounded session title",
      "phase": "running",
      "updatedAt": 1787845600000,
      "deepLink": "/sessions/session-id"
    }
  ]
}
```

Allowed phases are `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `cancelled`, and `stale`. A snapshot contains at most 500 states. Non-terminal rows are three-minute leases refreshed by the WebUI heartbeat. Missing rows expire instead of being immediately tombstoned, so a WebUI restart cannot incorrectly end Gateway-owned work before reconciliation.

The per-session route remains available at `PUT /v1/publishers/{publisherId}/sessions/{sessionId}/activity` with `eventId`, `revision`, and `state`; use `state: null` to tombstone it.

## Device and Live Activity routes

`PUT /v1/devices/{deviceId}` upserts the signed-in user's device:

```json
{
  "label": "Talaria iPhone",
  "bundleId": "dev.kil.talaria",
  "apsEnvironment": "sandbox",
  "pushToken": "optional ordinary APNs token",
  "pushToStartToken": "optional ActivityKit push-to-start token",
  "preferences": {
    "liveActivitiesEnabled": true,
    "notificationsEnabled": false,
    "notifyOnApproval": true,
    "notifyOnInput": true,
    "notifyOnCompletion": true,
    "notifyOnFailure": true
  }
}
```

Send either token field as `null` to clear the stored token. The relay uses `pushToStartToken` to start the aggregate Live Activity when work begins while no aggregate activity is registered.

Register an aggregate ActivityKit token with `PUT /v1/devices/{deviceId}/live-activities/{activityId}`:

```json
{
  "mode": "all_running",
  "attributesType": "TalariaAggregateActivityAttributes",
  "schemaVersion": 1,
  "activityPushToken": "activity-token",
  "seededLocally": false
}
```

Set `seededLocally` to `true` only when the foreground app created a short-lived placeholder before the publisher emitted its first state. The relay preserves that empty placeholder for 30 seconds so authoritative publisher state can repaint it.

End an activity with `DELETE /v1/devices/{deviceId}/live-activities/{activityId}` and revoke a device with `DELETE /v1/devices/{deviceId}`. A token cannot be claimed by another relay user.

## Publisher subscriptions and revocation

Existing publishers are subscribed on every device by default. List the current device's publisher state with authenticated `GET /v1/devices/{deviceId}/publisher-subscriptions`.

Subscribe or unsubscribe only that device with authenticated `PUT /v1/devices/{deviceId}/publisher-subscriptions`:

```json
{
  "publisherId": "https://hermes.example.com",
  "subscribed": false
}
```

An unsubscribed publisher is excluded from that device's aggregate snapshots, ActivityKit delivery, and notifications. Other devices remain subscribed.

Revoke a publisher for the whole relay account with authenticated `DELETE /v1/publisher-enrollment?publisherId=https%3A%2F%2Fhermes.example.com`. Revocation disables the publisher, revokes its keys, retires its current states, and recomputes delivery for every device. Pairing it again creates a new publisher key.

## Foreground snapshot

`GET /v1/activity-snapshot?mode=all_running` also requires `X-Talaria-Device-Id`. Talaria uses it only to seed or end an activity while foregrounded; APNs owns later updates while suspended.
