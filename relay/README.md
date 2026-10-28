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
FEEDBACK_OPERATOR_TOKEN_SHA256
```

`APPLE_SUBJECT_HASH_KEY` is a random server secret used to pseudonymize Apple's stable subject before storage. APNs credentials and this hash key never enter the database or API responses.

`FEEDBACK_OPERATOR_TOKEN_SHA256` is the lowercase hex SHA-256 of the feedback bridge's bearer token (`printf %s "$TOKEN" | shasum -a 256`). Feedback routes answer 404 until it is set; the token itself stays with the bridge.

Signed `relay-vX.Y.Z` tags validate release identity. The authorized root
`production-cutover.yml` workflow deploys changed Relay releases into the existing
production deployment, using `CONVEX_DEPLOY_KEY` from the `relay-production`
environment. It verifies readiness and provenance before Web or App publication.

The production HTTP origin is `https://relay.talaria.kil.dev`.

## Feedback bridge

`node bridge/bridge.ts` runs once on Node 24 using only built-in modules. It
pulls up to 50 pending reports from Relay, creates quarantined Inbox tickets
through Kanvil's create-only intake scope, acknowledges successful deliveries,
and exits. Reports and diagnostics remain fenced untrusted text; install IDs
are hashed before inclusion in ticket metadata.

| Environment variable | Purpose |
| --- | --- |
| `RELAY_URL` | Relay HTTP origin |
| `FEEDBACK_OPERATOR_TOKEN` | Bearer token whose hash is configured on Relay |
| `KANVIL_URL` | Cluster-internal Kanvil base URL |
| `KANVIL_INTAKE_KEY` | Create-only `intake` key bound to Talaria Inbox |
| `KANVIL_PROJECT_ID` | Talaria Inbox project ID |

Use the `intake` scope provided by KAN-67. It forces human triage and disables
automation on created tickets. The bridge sends exactly the `user-report`,
trust-tier, and client-platform labels; Kanvil adds its own `intake` label.
Credentials stay in the cluster and are never logged. Missing variables or an
invalid base URL exit 2 and name only the variable. Queue failures exit 1.
Individual create or acknowledgement failures leave reports pending, continue
with the rest, then exit 1. Each HTTP request has a 30-second timeout and refuses
redirects. A rerun resends the same report request ID and identical ticket input,
so a lost acknowledgement cannot create another ticket. Exit 0 means all
reports in the fetched batch were delivered, or the queue was empty.

The image is `ghcr.io/maudecode/talaria-feedback-bridge`, tagged `sha-<12-hex>`
and `main`. Pull requests build and smoke-test it; bridge changes on main also
publish it. The image runs as the non-root `node` user and contains only the
standalone entry file beyond the base image. No package installation is needed.

Deployment is separate. The intended in-cluster Kubernetes CronJob schedule is
`*/2 * * * *` with `concurrencyPolicy: Forbid`, the five variables above supplied
from cluster configuration/secrets, and a pinned SHA image. Kanvil remains
internal; only the bridge connects outbound to Relay. These source changes do
not configure a deployment or enable Relay's feedback routes.

## Remaining real-boundary proof

After Apple enables Sign in with Apple for the Talaria App ID and production configuration is installed:

1. Sign in from a physical iPhone.
2. Register an authenticated Hermes server as its owner, then enroll each Hermes profile from Talaria Settings.
3. Start concurrent Hermes sessions and arm the aggregate Live Activity.
4. Lock the phone and verify APNs update/end plus approval/input notification fallback.

See [docs/http-api.md](docs/http-api.md) for the v1 contract.
