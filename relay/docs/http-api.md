# Relay HTTP API v1

All bodies are JSON. User-authenticated routes use `Authorization: Bearer <relay session token>`.
User-authenticated route failures return a non-2xx status with `{ "error": "<code>" }`. Signed publisher state routes answer conflicts with their `status` result instead (below).

## Health and release identity

`GET /v1/health` retains its readiness status and adds a `release` object:
version, source revision, deployment identifier, release-set identifier and
supported `webRelay`, `appRelay` and `activityScene` capabilities. Development
checkouts report null release/deployment identities. The root release build
stamps `convex/releaseInfo.json` from its clean exact checkout with
`python3 scripts/stamp-release.py relay --version X.Y.Z --source-revision SHA --deployment-id NAME`.
That file is bundled with the deployed functions; mutable environment variables
cannot substitute a different source revision. A release is complete only after
the deployment target's health response matches the expected stamped identity.
These fields are diagnostics, not an exact peer-version requirement.

## Apple sign-in

`POST /v1/auth/apple`

```json
{
  "identityToken": "Apple identity JWT",
  "nonce": "SHA-256 nonce sent in the Apple authorization request"
}
```

The relay verifies the ES256 signature against Apple's JWKS plus issuer, audience, expiry, nonce, and token replay. It returns an opaque 30-day relay session token. End it with `DELETE /v1/auth/session`.

## Server registration and profile enrollment

This is the v2 contract. The relay ignores v1 publishers, keys, nonces, and session states rather than migrating or authorizing them. Re-registration creates v2 records alongside any inert v1 rows.

Talaria creates a ten-minute invitation with authenticated `POST /v1/pairings/publisher` and passes it through the authenticated Hermes API.

The Hermes owner registers the server once. Hermes generates an Ed25519 key locally and redeems the invitation with an opaque profile scope:

`POST /v1/pairings/publisher/redeem`

```json
{
  "invitation": "one-time invitation",
  "publisherId": "https://hermes.example.com",
  "profileId": "opaque-server-generated-profile-scope",
  "label": "Home Hermes",
  "publicKey": "base64url raw Ed25519 public key"
}
```

The private key never leaves the Hermes machine.
Repeating server registration with an invitation from the publisher's original relay owner creates a replacement key. The relay activates it on first signed publication and then revokes the previous key without changing profile grants.
Successful registration and enrollment responses include `protocolVersion: 2`. Registration also returns `profileIdPreserved`: `false` requires an exact echo of the requested scope, while `true` tells Hermes that owner key recovery retained the existing owner grant. Hermes rejects any unmarked scope mismatch before treating local configuration as valid.

Registrations are keyed by relay owner plus server origin. Another relay user can claim the same public origin only inside their own account; that claim cannot reserve the origin, block the legitimate owner, authenticate the legitimate publisher, or receive its profile grants.

After registration, any authenticated Hermes profile can enroll. Hermes resolves the profile from its trusted session, never from a client-supplied profile name, and signs:

`POST /v1/pairings/profile/redeem`

```json
{
  "invitation": "one-time invitation",
  "publisherId": "https://hermes.example.com",
  "profileId": "opaque-server-generated-profile-scope"
}
```

The request uses publisher authentication below. One relay user receives one profile grant for a publisher. Re-enrollment may replace that user's old profile grant without rotating or replacing the server key.

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

`PUT /v1/publishers/{publisherId}/profiles/{profileId}/snapshot`

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
      "phase": "completed",
      "activityPhase": "running",
      "startedAt": 1787845500000,
      "updatedAt": 1787845600000,
      "deepLink": "/sessions/session-id"
    }
  ]
}
```

Allowed phases are `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `cancelled`, and `stale`. A snapshot contains at most 500 states. Non-terminal activity has a three-minute lease refreshed by the WebUI heartbeat. Missing rows do not immediately tombstone work, so a WebUI restart cannot incorrectly end Gateway-owned work before reconciliation.

`phase` remains the foreground turn's outcome. Optional `activityPhase` uses the
same vocabulary and is the server's session-wide decision, including confirmed
delegations, notified/watched processes, and `/background` commands. Activities,
aggregate rows, transition alerts and leases use `activityPhase` when present;
older publishers fall back to `phase`. Completion history and acknowledgements
continue to use `phase` and the original `streamId`. A completed turn with
`activityPhase: "running"` therefore renders Working without ending its activity.
Unconfirmed work publishes `stale`; it never counts as confirmed active work.
Aggregates include additive `isFinal`, true only when all session work is settled,
and `isStale`, the server's decision to use the stale presentation. Clients render
these decisions, so zero confirmed active sessions with stale work cannot render
success.

For publishers supplying `activityPhase`, Relay retains the current session row
after the activity lease expires and projects it as stale. Its existing cleanup
pass records that stale state and recomputes delivery. The Relay-owned lease
timestamp is not a publisher input. Retained parent-turn history cannot replace
unconfirmed work with Done, even after that history is acknowledged. A later
publication confirms running or settled work. Publishers omitting the additive
field retain their existing row-expiration behavior.

Unconfirmed activity rows expire 24 hours after their last accepted publication.
After that retention window, the activity retires without presenting the parent's
reply as a settled session outcome. The completion inbox still retains the actual
reply outcome and its acknowledgement state. Snapshot and per-session ingestion
share a transactional limit of 500 stored session rows per user/publisher grant,
including tombstones awaiting cleanup. A request that would exceed it fails with
`too_many_states` and commits no partial updates; existing rows can still be
updated or revoked at the limit.

Each state may carry `startedAt`, the run's start in epoch milliseconds (a non-negative integer). Relay copies it onto the aggregate row and uses it as the native Live Activity's timer start, so the lock screen counts from the same instant as the chat. Publishers that omit it fall back to when Relay registered the activity.

Each state may carry an optional `alertEligible` boolean. Omitting it means `true`. `alertEligible: false` applies only to the exact event carrying it, including a session's first publication: the relay still persists the transition and delivers the Live Activity state silently, but produces no ordinary notification and no `alert` or sound on a Live Activity update or end. Because APNs requires an alert on push-to-start, an ineligible transition on a device with no running Live Activity defers the start, and the deferral persists on that device while the suppressed state is visible and otherwise until an eligible phase transition, an activity registration, or idle work releases it. The stored value carries forward across same-phase updates of the same run (same `streamId`) until the next phase transition or a new run, so a later heartbeat or eligibility change in the same phase never alerts or starts an activity for the already-consumed transition.

The per-session route remains available at `PUT /v1/publishers/{publisherId}/profiles/{profileId}/sessions/{sessionId}/activity` with `eventId`, `revision`, and `state`; use `state: null` to tombstone it.

Web session deletion uses its existing durable cleanup outbox to acknowledge
completion history and then publish this tombstone. Both snapshots and
tombstones reserve monotonic revisions in the same persisted publisher record,
so a restart cannot reuse a deletion's revision for a new activity.

## Announce a new session

`PUT /v1/publishers/{publisherId}/profiles/{profileId}/sessions/{sessionId}/started`

```json
{
  "version": 1,
  "eventId": "started:session-id",
  "publisherId": "https://hermes.example.com",
  "profileId": "opaque-server-generated-profile-scope",
  "sessionId": "session-id",
  "startedAt": 1787845600000
}
```

The publisher sends this once when a session first appears in an enrolled profile, whether it started in Talaria Web or in the Agent. `startedAt` is the session's start in publisher milliseconds. A retry or restart reuses the same `eventId`, so the relay may deduplicate on it. The body carries exactly these fields and nothing from the transcript: an unknown field, a value past its bound, or a `sessionId` that differs from the path answers 400. A `publisherId` or `profileId` that differs from the path answers 403, and a profile this publisher has not enrolled answers 409 with `status: "unauthorized"`. The relay validates and acknowledges the event; it does not deliver anything to devices yet.

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

The relay rechecks current device preferences before each queued or retried delivery attempt. Disabling ordinary notifications or an event category prevents queued ordinary alerts for that category. Disabling an event category removes the alert and sound from otherwise valid Live Activity updates, while disabling Live Activities prevents queued updates and starts. Silent end and displacement cleanup can still finish existing activities. Ordinary notification enablement does not control Live Activity alerts. Requests already accepted by APNs cannot be retracted.

Approval and input alerts are Time Sensitive (`interruption-level: time-sensitive`) so they can break through Focus. On a device that can receive ordinary notifications, they always arrive as a standalone notification, even while a Live Activity runs; that transition's Live Activity update or end carries no `alert`, and a push-to-start carries its required `alert` without `sound`, so the user hears one sound. A device without notifications enabled or a notification token keeps these alerts on its Live Activity. Completion and failure alerts keep the default interruption level and sound on the Live Activity instead of a standalone notification.

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

An unsubscribed publisher is excluded from that device's aggregate snapshots, ActivityKit delivery, and notifications. Other devices remain subscribed. Register the device with `PUT /v1/devices/{deviceId}` first; otherwise the relay returns 404 `device_not_registered`.

Revoke the signed-in relay account's profile grant with authenticated `DELETE /v1/publisher-enrollment?publisherId=https%3A%2F%2Fhermes.example.com`. Revocation retires only that account's states and recomputes its devices. The registered publisher, signing key, and other profile grants remain active.

## Foreground snapshot

`GET /v1/activity-snapshot?mode=all_running` also requires `X-Talaria-Device-Id`. Talaria uses it only to seed or end an activity while foregrounded; APNs owns later updates while suspended.


## Retained completions

A terminal run is retained as semantic content until explicitly acknowledged. An
existing Live Activity receives an `update` containing Done/Failed/Cancelled;
terminal-only content does not initiate a remote start or repeated keepalive pushes.
Active sessions take display priority. The bounded activity displays one outcome
per session; the paginated inbox retains every run independently of session expiry.
ActivityKit may still expire or dismiss the on-device activity.

`GET /v1/activity-completions` requires the normal bearer credential and
`X-Talaria-Device-Id`. It returns `{completions:[{id,row}],cursor}` with at most 100
records per page. Pass the returned non-null cursor as `?cursor=...` to continue.
Empty pages may still have a cursor when publisher exclusions hide their records.

`POST /v1/activity-completions/acknowledge` uses the same authentication and accepts
`{ids:[...]}` (at most 100 observed completion IDs). Success returns `{ok:true}`.
Acknowledgement is account-wide for those exact records; it does not clear running
work, later runs or another user's/profile's results. Retries are idempotent.
Acknowledgement tombstones prevent later terminal snapshots from reviving a result
and are deleted seven days after the run's completion was first recorded.
Revoked/expired devices, excluded publishers and obsolete profile grants are denied.
Revoking a publisher deletes its completions, and cleanup deletes any completion
whose grant is gone or was re-enrolled for another owner or profile.

A publisher reports that a session was viewed in its own client with the signed
`PUT /v1/publishers/{publisherId}/profiles/{profileId}/sessions/{sessionId}/viewed`
and body `{ "through": 1787845600000 }` (Unix milliseconds). The relay acknowledges
every pending completion of that profile's grants for the session whose `updatedAt`
is at or before `through` (both on the publisher's clock), and returns
`{status:"accepted",acknowledged:N}`. Running work and later runs are untouched.
A replayed nonce returns 409 and changes nothing.

A completion uses the publisher's stream ID as its durable run identity. Legacy
streamless publishers are grouped by the observed session lifecycle; publishers
should provide a stable stream ID to distinguish runs after session-state expiry.
The additive row fields `streamId` and `completionId` may be ignored by old clients.
New completion UI requires this relay release; deploy the relay before the app.

Current-session activity registration also accepts an optional `streamId`. New
clients provide it to pin the Activity to its original run. Later runs do not
replace or repaint retained cards for another stream; explicit acknowledgement
clears each finished run. Registrations without this field retain legacy
single-card replacement behavior.

## Feedback reports

Talaria Web servers forward user bug reports and feature requests to Relay. An
in-cluster operator bridge pulls them from the queue below; clients never hold
a tracker credential. Every feedback route answers 404 until the deployment sets
`FEEDBACK_OPERATOR_TOKEN_SHA256`.

`POST /v1/feedback` accepts at most 32 KiB of JSON. The shared example is
`contracts/fixtures/feedback-report.json`.

```json
{
  "requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "installId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "kind": "bug",
  "title": "Composer loses the draft after reconnecting",
  "body": "Plain-text description",
  "client": { "platform": "web", "appVersion": "1.4.0", "osVersion": "macOS 26.1", "deviceModel": "Mac" },
  "server": { "webVersion": "1.4.0", "agentVersion": "0.9.2" },
  "diagnostics": "optional plain text",
  "attachments": [
    { "contentType": "image/png", "bytes": 48213, "sha256": "<64 lowercase hex>" }
  ]
}
```

| Field | Rule |
|---|---|
| `requestId`, `installId` | UUID |
| `kind` | `bug`, `feature`, or `other` |
| `title` | 1–120 characters |
| `body` | 1–8000 characters |
| `client.platform` | `web` or `ios` |
| `client.appVersion`, `client.osVersion`, `client.deviceModel` | optional, 1–64 characters |
| `server.webVersion` | 1–64 characters |
| `server.agentVersion` | optional, 1–64 characters |
| `diagnostics` | optional, 1–16384 characters |
| `attachments` | optional, 1–5 entries of exactly `{contentType, bytes, sha256}` |
| `attachments[].contentType` | `image/png`, `image/jpeg`, `image/heic`, `image/webp`, `video/mp4`, `video/quicktime`, or `video/webm` |
| `attachments[].bytes` | integer, 1 to 10,000,000 for images or 20,000,000 for video; at most one video per report |
| `attachments[].sha256` | SHA-256 of the file, 64 lowercase hex characters |

`contracts/fixtures/feedback-attachment-limits.json` is the single table of
attachment types, sizes, counts, the 120-second video limit (enforced by the
operator bridge, which can parse media), and which tier may attach which kind.

Strings must not be blank. Optional fields are omitted, not `null`. Relay stores
the text as given and never renders or interprets it. An unknown field at any
level, a value past its bound, or an invalid enum answers 400
`{error:"invalid_feedback"}`; an oversize body answers 400
`{error:"body_too_large"}`.

A request carrying any [publisher authentication](#publisher-authentication)
header is a **verified** submission: Relay identifies the registered publisher
from `X-Talaria-Key-Id` and checks the signature over path `/v1/feedback`, the
timestamp window, and nonce replay. Any failure answers 401 and stores nothing;
it never falls back to the unverified tier. A request without those headers is
**unverified**.

| Budget | Limit |
|---|---|
| Verified, per publisher registration (owner and origin) | 20 an hour |
| Unverified, per `installId` | 5 an hour |
| Unverified, all installs | 200 a day |
| Every tier | 1000 a day |

Windows are fixed and start at their first accepted report. An exhausted budget
answers 429 `{error:"rate_limited"}` with `Retry-After` in seconds, and a refused
report charges no budget.

Success answers 202 `{reportId}`. Resending the same `requestId` with the same
payload returns the original `reportId` without charging a budget; the same
`requestId` with a different payload, including a different attachment
manifest, answers 409 `{error:"idempotency_conflict"}`.

### Attachments

A report with `attachments` answers 202 with one admission per manifest entry:

```json
{
  "reportId": "opaque-report-id",
  "attachments": [
    { "index": 0, "status": "accepted", "uploadToken": "base64url", "expiresAt": 1787847400000 },
    { "index": 1, "status": "refused", "reason": "tier" }
  ]
}
```

An attachment is refused, and the report still accepted, for one of these
reasons. A refused attachment charges no budget.

| Reason | When |
|---|---|
| `tier` | the report is unverified; only verified reports may attach files, up to five images or four images and one video |
| `quota` | its declared bytes would exceed a byte budget below, or take stored attachment bytes past 2 GB |
| `disabled` | the deployment sets `FEEDBACK_ATTACHMENTS_DISABLED=1` |

| Byte budget (declared bytes of accepted attachments) | Limit |
|---|---|
| Verified, per publisher registration | 200 MB a day |
| All publishers | 600 MB a day and 6 GB per 30 days |

Upload each accepted file with
`PUT /v1/feedback/{reportId}/attachments/{index}`, `Authorization: Bearer
<uploadToken>`, and a `Content-Length` equal to the declared `bytes`. The token
is valid until `expiresAt`, 30 minutes after admission, and is consumed when the
file is stored. Success answers 200 `{reportId, index, status:"stored"}`.

| Answer | When |
|---|---|
| 400 `{error:"invalid_attachment"}` | `Content-Length` is missing or differs from `bytes`, or the body's length, SHA-256, or leading bytes do not match the declared type; nothing is stored and the token stays valid for a retry |
| 401 `{error:"unauthorized"}` | the token is missing, wrong, belongs to another attachment, or was already used |
| 410 `{error:"upload_expired"}` | the upload window closed |
| 503 `{error:"attachments_disabled"}` | the kill switch is set |

The leading bytes must be the PNG signature, JPEG `FF D8 FF`, WebP
`RIFF....WEBP`, the WebM EBML header `1A 45 DF A3`, or for HEIC, MP4, and
QuickTime an `ftyp` box whose major brand belongs to that type.

Resending the same submission reissues a token, with the original `expiresAt`,
for each attachment still awaiting upload and invalidates the previous one;
stored attachments answer `{index, status:"stored"}` and closed windows
`{index, status:"missing"}`.

### Operator queue

Both operator routes require `Authorization: Bearer <token>`, where the SHA-256
of the token, as lowercase hex, equals `FEEDBACK_OPERATOR_TOKEN_SHA256`. A
missing or wrong token answers 401.

`GET /v1/feedback/pending?limit=50` returns at most `limit` (1–50, default 50)
pending reports, oldest first:

```json
{
  "reports": [
    {
      "reportId": "opaque-report-id",
      "tier": "verified",
      "publisherId": "https://hermes.example.com",
      "createdAt": 1787845600000,
      "payload": { "requestId": "…", "kind": "bug", "title": "…" },
      "attachments": [
        { "index": 0, "contentType": "image/png", "bytes": 48213, "sha256": "…", "status": "stored" },
        { "index": 1, "contentType": "video/mp4", "bytes": 9000000, "sha256": "…", "status": "refused", "reason": "tier" }
      ]
    }
  ]
}
```

`publisherId` is present only for verified reports. Another `limit` answers 400
`{error:"invalid_limit"}`. A report with attachments joins the queue once each
accepted file is stored or its upload window closes; a file never uploaded is
listed as `missing`. `attachments` is empty for a text-only report.

Outside HTTP, the Convex query `feedback:pendingSignal({token})` returns the IDs
of the same first 50 pending reports and nothing else. The bridge subscribes to
it over the Convex client WebSocket to learn of new reports at once. The token
rule is the same; a wrong token, or an unset hash, fails the query with
`unauthorized`.

Acknowledging a report deletes its files, so the bridge must copy them first. A
bridge that predates attachments acknowledges without copying; deploy one that
copies them before any client sends attachments, or set
`FEEDBACK_ATTACHMENTS_DISABLED=1` until then.

`GET /v1/feedback/{reportId}/attachments/{index}` returns a stored file as
`application/octet-stream` with `X-Content-Type-Options: nosniff`, or 404 when
it is not stored.

`POST /v1/feedback/{reportId}/ack` with exactly `{ "ticketKey": "TAL-123" }`
marks the report delivered and removes it from the pending list. It returns
`{reportId, ticketKey, status:"delivered"}`; repeating it with the same key does
the same. A different key for a delivered report answers 409
`{error:"ticket_key_conflict"}`, an unknown report 404, and a malformed key 400
`{error:"invalid_ticket_key"}`.

Acknowledging a report deletes its stored files at once. Cleanup deletes
delivered reports seven days after delivery and pending reports 30 days after
submission; it deletes the files of a pending report seven days after
submission and lists them as `missing`.
