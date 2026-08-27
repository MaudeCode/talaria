# Relay HTTP API v1

All request and response bodies are JSON. The relay exposes HTTP actions from the Convex site URL or its future custom domain.

## Enrollment

An operator creates one-time codes through the internal `admin:createEnrollmentCode` action. Codes expire after 15 minutes by default and are stored only as SHA-256 hashes.

### Enroll a publisher

`POST /v1/enrollments/publisher/redeem`

```json
{
  "code": "one-time-code",
  "label": "Home Hermes",
  "publicKey": "base64url-encoded-raw-ed25519-public-key"
}
```

The response returns `publisherId` and `keyId`. The private key remains on the WebUI machine.

### Enroll a device

`POST /v1/enrollments/device/redeem`

```json
{
  "code": "one-time-code",
  "label": "Kilian's iPhone"
}
```

The response returns `deviceId` and a random bearer credential once. Talaria stores the credential in Keychain; Convex stores only its hash.

## Publisher authentication

Publisher requests include:

```text
X-Talaria-Key-Id
X-Talaria-Timestamp    Unix seconds, at most five minutes from relay time
X-Talaria-Nonce        Unique per publisher request
X-Talaria-Signature    Base64url Ed25519 signature
```

The signed bytes are UTF-8:

```text
METHOD
PATH
TIMESTAMP
NONCE
BASE64URL_SHA256_OF_EXACT_BODY
```

The relay rechecks the key inside the accepting mutation, stores the nonce atomically, and requires increasing revisions per publisher/session.

## Publish one session

`PUT /v1/publishers/{publisherId}/sessions/{sessionId}/activity`

```json
{
  "eventId": "stable-event-id",
  "revision": 42,
  "state": {
    "sessionId": "session-id",
    "streamId": "optional-stream-id",
    "title": "Bounded session title",
    "phase": "running",
    "updatedAt": 1787845600000,
    "deepLink": "/sessions/session-id"
  }
}
```

Allowed phases:

```text
starting
running
waiting_for_approval
waiting_for_input
completed
failed
cancelled
stale
```

Send `state: null` with a newer envelope revision to tombstone a session. Duplicate event IDs return success; stale revisions and replayed nonces return conflict. The relay owns state expiry: running states last two hours, waiting states 24 hours, and terminal rows 15 minutes.

## Publish a complete snapshot

`PUT /v1/publishers/{publisherId}/snapshot`

```json
{
  "snapshotId": "stable-snapshot-id",
  "states": []
}
```

Each state has the same flat fields as the session `state` object, including `eventId` and `revision`. A complete snapshot may contain at most 500 states. Missing sessions are tombstoned only within that publisher; another publisher's rows are never affected.

## Device authentication

Device routes use:

```text
Authorization: Bearer <device credential>
```

Snapshot requests also include `X-Talaria-Device-Id`.

## Register device routing

`PUT /v1/devices/{deviceId}`

```json
{
  "label": "Kilian's iPhone",
  "bundleId": "dev.kil.talaria",
  "apsEnvironment": "sandbox",
  "pushToken": "optional ordinary APNs token",
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

Device and ActivityKit tokens are globally claimed. Registering a token on a new device/activity retires its previous owner. Omit `pushToken` to preserve it; send `null` to clear it.

## Register a Live Activity

`PUT /v1/devices/{deviceId}/live-activities/{activityId}`

```json
{
  "mode": "all_running",
  "attributesType": "TalariaAggregateActivityAttributes",
  "schemaVersion": 1,
  "activityPushToken": "activity-token"
}
```

`per_session` mode also requires `publisherId` and `sessionId`. A device keeps at most one live registration per mode. Registration schedules an immediate state replay.

End one activity with `DELETE /v1/devices/{deviceId}/live-activities/{activityId}`. Revoke a device with `DELETE /v1/devices/{deviceId}`.

## Read a foreground snapshot

Aggregate mode:

`GET /v1/activity-snapshot?mode=all_running`

Per-session mode:

`GET /v1/activity-snapshot?mode=per_session&publisherId=...&sessionId=...`

Talaria uses this only to decide whether to arm and seed an activity while foregrounded. APNs owns later updates after suspension.
