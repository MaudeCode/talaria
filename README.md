# Talaria Relay

Private Convex relay for Talaria notifications and Live Activities.

Hermes WebUI publishers send bounded semantic session state. The relay aggregates state from every enrolled publisher, stores relay-wide device and ActivityKit tokens, and queues APNs delivery. It does not accept transcript text, commands, tool arguments, file paths, or provider credentials.

## Current status

Implemented and locally verified:

- One-time publisher and device enrollment.
- Ed25519-signed publisher requests with timestamp, nonce, and revision replay protection.
- Relay-wide devices plus cross-publisher `all_running` aggregation.
- `per_session` and `all_running` Live Activity registrations.
- Bounded aggregate rows, attention-first ordering, terminal retention, and stale-state expiry.
- Workpool delivery with serialized APNs actions, retries, completion handling, and stale token/state rejection.
- ActivityKit update/end payloads and ordinary notification fallback.
- APNs ES256 provider-token reuse and Node `http2` transport.
- Five-minute pruning of expired nonces, codes, session state, and old delivery jobs.

Still requires maintainer setup:

- Production Convex deployment selection.
- APNs environment values and `.p8` key.
- Custom domain attachment.
- A physical-iPhone APNs sandbox proof.
- Hermes publisher and Talaria client integrations in their own repositories.

## Local development

```sh
pnpm install
pnpm convex deployment select local
pnpm dev
```

The checked-in Convex project is `talaria-relay`; `.env.local` selects the uncommitted local deployment.

Run checks:

```sh
pnpm check
pnpm convex dev --once --typecheck enable
```

Create short-lived enrollment codes from a trusted Convex CLI session:

```sh
pnpm convex run admin:createEnrollmentCode '{"kind":"publisher"}'
pnpm convex run admin:createEnrollmentCode '{"kind":"device"}'
```

Enroll a WebUI publisher and create its local Ed25519 private key:

```sh
PUBLISHER_ENROLLMENT_CODE=... pnpm enroll:publisher
```

The command prints the four `HERMES_WEBUI_TALARIA_*` settings to copy into the
WebUI `.env`; it writes the private key with mode `0600` and never prints it.

Exercise publisher enrollment, device enrollment, signed state publication, duplicate/stale revision handling, and aggregate snapshot retrieval:

```sh
PUBLISHER_ENROLLMENT_CODE=... \
DEVICE_ENROLLMENT_CODE=... \
pnpm smoke
```

## APNs configuration

Set these as Convex deployment environment variables when credentials are available:

```text
APNS_TEAM_ID
APNS_KEY_ID
APNS_PRIVATE_KEY
```

Bundle ID and sandbox/production routing are registered per Talaria device. The private key never enters the database or API responses.

The Workpool has `maxParallelism: 1`, so provider-token creation and APNs sends stay serialized. Provider JWTs are stored for 45 minutes, below Apple's one-hour lifetime.

## Repository boundary

This repository is temporary. When Talaria consolidates into its monorepo, its contents can move under `relay/` without changing the HTTP contract.

See [docs/http-api.md](docs/http-api.md) for the version 1 contract.
