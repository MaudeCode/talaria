# Talaria Relay

Run component commands from `relay/`. Repository workflows live in
`../.github/`. See the [root release procedure](../releases/README.md) for
publication.

Profile-isolated Convex relay for Talaria notifications and aggregate Live Activities.

Talaria signs in natively with Apple and receives a relay session. An owner registers each Hermes server once, and Hermes stores its Ed25519 signing key locally. Any authenticated Hermes profile can then redeem its relay invitation through that registered publisher. Hermes publishes a separate signed snapshot for each opaque profile scope, and the relay copies state only into relay accounts granted that scope.

The v2 enrollment model intentionally does not accept v1 publisher credentials. Existing v1 rows remain inert so the schema can deploy without destructive cleanup; servers and users must register and enroll again.

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

Signed `relay-vX.Y.Z` tags validate release identity. The authorized root
`production-cutover.yml` workflow deploys changed Relay releases into the existing
production deployment, using `CONVEX_DEPLOY_KEY` from the `relay-production`
environment. It verifies readiness and provenance before Web or App publication.

The production HTTP origin is `https://relay.talaria.kil.dev`.

## Remaining real-boundary proof

After Apple enables Sign in with Apple for the Talaria App ID and production configuration is installed:

1. Sign in from a physical iPhone.
2. Register an authenticated Hermes server as its owner, then enroll each Hermes profile from Talaria Settings.
3. Start concurrent Hermes sessions and arm the aggregate Live Activity.
4. Lock the phone and verify APNs update/end plus approval/input notification fallback.

See [docs/http-api.md](docs/http-api.md) for the v1 contract.
