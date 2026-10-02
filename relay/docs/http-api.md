# Relay HTTP API v1

All bodies are JSON. User-authenticated routes use `Authorization: Bearer <relay session token>`.

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
      "phase": "running",
      "updatedAt": 1787845600000,
      "deepLink": "/sessions/session-id"
    }
  ]
}
```

Allowed phases are `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `cancelled`, and `stale`. A snapshot contains at most 500 states. Non-terminal rows are three-minute leases refreshed by the WebUI heartbeat. Missing rows expire instead of being immediately tombstoned, so a WebUI restart cannot incorrectly end Gateway-owned work before reconciliation.

Each state may carry an optional `alertEligible` boolean. Omitting it means `true`. `alertEligible: false` applies only to the exact event carrying it, including a session's first publication: the relay still persists the transition and delivers the Live Activity state silently, but produces no ordinary notification and no `alert` or sound on a Live Activity update or end. Because APNs requires an alert on push-to-start, an ineligible transition on a device with no running Live Activity defers the start, and the deferral persists on that device while the suppressed state is visible and otherwise until an eligible phase transition, an activity registration, or idle work releases it. The stored value carries forward across same-phase updates of the same run (same `streamId`) until the next phase transition or a new run, so a later heartbeat or eligibility change in the same phase never alerts or starts an activity for the already-consumed transition.

The per-session route remains available at `PUT /v1/publishers/{publisherId}/profiles/{profileId}/sessions/{sessionId}/activity` with `eventId`, `revision`, and `state`; use `state: null` to tombstone it.

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
Acknowledgement tombstones prevent later terminal snapshots from reviving a result.
Revoked/expired devices, excluded publishers and obsolete profile grants are denied.

A publisher reports that a session was viewed in its own client with the signed
`PUT /v1/publishers/{publisherId}/profiles/{profileId}/sessions/{sessionId}/viewed`
and body `{ "through": 1787845600000 }` (Unix milliseconds). The relay acknowledges
every pending completion of that profile's grants for the session whose `updatedAt`
is at or before `through`, clamped to relay time, and returns
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
