# Talaria Relay

Tenant-isolated Convex relay for Talaria notifications and aggregate Live Activities.

Talaria signs in natively with Apple and receives a relay session. It creates a short-lived publisher invitation and sends it through the already-authenticated Hermes WebUI API. Hermes redeems the invitation, stores its Ed25519 signing key locally, and publishes complete session snapshots. The relay scopes publishers, devices, session state, ActivityKit tokens, and APNs jobs to the Apple-backed relay user.

The relay accepts bounded semantic state only. It does not accept transcripts, commands, tool arguments, file paths, provider credentials, or Hermes authentication secrets.

## Local development

```sh
pnpm install
pnpm convex deployment select local
pnpm dev
```

Run all local checks:

```sh
pnpm check
pnpm convex dev --once --typecheck enable
```

## Production configuration

Set these once on the production Convex deployment:

```text
APNS_TEAM_ID
APNS_KEY_ID
APNS_PRIVATE_KEY
APPLE_SUBJECT_HASH_KEY
APPLE_CLIENT_IDS=dev.kil.talaria,dev.kil.talaria.branch
```

`APPLE_SUBJECT_HASH_KEY` is a random server secret used to pseudonymize Apple's stable subject before storage. APNs credentials and this hash key never enter the database or API responses.

Production deploys are tag-only. Tags matching `relay-v*` run the full check suite and deploy with the repository's `CONVEX_DEPLOY_KEY` GitHub Actions secret.

The production HTTP origin is `https://relay.talaria.kil.dev`.

## Remaining real-boundary proof

After Apple enables Sign in with Apple for the Talaria App ID and production configuration is installed:

1. Sign in from a physical iPhone.
2. Pair an authenticated Hermes server from Talaria Settings.
3. Start concurrent Hermes sessions and arm the aggregate Live Activity.
4. Lock the phone and verify APNs update/end plus approval/input notification fallback.

See [docs/http-api.md](docs/http-api.md) for the v1 contract.
