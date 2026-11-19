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

A `relay-vX.Y.Z` tag marks a Relay release that shipped. The authorized root
`production-cutover.yml` workflow deploys changed Relay releases into the existing
production deployment, using `CONVEX_DEPLOY_KEY` from the `relay-production`
environment. It verifies readiness and provenance before Web or App publication.

The production HTTP origin is `https://relay.talaria.kil.dev`.

## Feedback bridge

`node bridge/bridge.ts` runs once on Node 24. It pulls up to 50 pending reports
from Relay, creates quarantined Inbox tickets through Kanvil's intake scope,
attaches sanitized copies of the report's files, acknowledges successful
deliveries, and exits.

With `RELAY_SYNC_URL` set it runs in watch mode instead and does not exit. It
holds an outbound Convex WebSocket subscription to `feedback:pendingSignal`,
which returns only the IDs of up to 50 pending reports and only for the operator
token. When that set changes and is not empty, the bridge runs a delivery at
once. A report counts as pending only after its uploads finish or their window
closes, so attachments are never delivered early. Deliveries run one at a time:
a change during a run queues exactly one more. A delivery also runs every 120
seconds so failed reports are retried. A subscription error (wrong token,
feedback disabled) prints one fixed line and exits 1. SIGTERM exits 0 after the
current delivery.

With `HEALTH_PORT` also set, watch mode serves `GET /healthz` on that port.
It answers 200 once Relay has answered the subscription (so the token is
authorized) and while the WebSocket is connected, and 503 otherwise. Any other
request gets 404. Use it as the readiness probe. Reports and diagnostics remain fenced untrusted text;
install IDs are hashed before inclusion in ticket metadata. The bridge keeps
its own npm lockfile because its image installs from it; `scripts/check relay`
installs both before `pnpm check`.

Every attachment is untrusted. The bridge downloads each stored file and checks
its length and SHA-256 against the queue entry before any ticket exists. It never
parses media: it sends each file to the sanitizer, a separate process holding no
Relay or Kanvil credential (see [Sanitizer](#sanitizer)), which re-encodes it in a
per-request temporary directory. Images go through
[sharp](https://sharp.pixelplumbing.com/) (100 megapixel input limit, fit inside
2560×2560, PNG stays PNG and other types become JPEG), which drops EXIF, GPS,
XMP and ICC data. sharp's bundled libvips cannot decode HEVC, so ffmpeg first
turns a HEIC (an iPhone tile grid, with its rotation applied) into a PNG, scaled
to fit 2560×2560 while decoding; its probe refuses a grid over 100 megapixels
before decoding. Video goes through ffmpeg: one video stream, at most 120.5
seconds, re-encoded to a silent H.264 MP4 without metadata, at most 1280 pixels
wide and 10,000,000 bytes. A file that fails these checks is dropped, and the
ticket's Attachments table names the reason: `failed validation`, `too long`,
`too large`, `missing`, or `refused (tier|quota|disabled)`. Files are named
`attachment-<index>.<ext>`; a retry uploads only the names the ticket lacks, and
the report is acknowledged only after every kept file is attached.

The bridge treats the sanitizer's answer as untrusted too. It refuses redirects
and allows 300 seconds per file. A kept file must be PNG, JPEG or MP4, at most
10,000,000 bytes, with its length and SHA-256 matching the response headers; a
dropped file must name one of the reasons above. An unreachable sanitizer or any
other answer leaves the report pending with no ticket or acknowledgement, and
the next run retries it. There is no in-process fallback.

| Environment variable | Purpose |
| --- | --- |
| `RELAY_URL` | Relay HTTP origin |
| `FEEDBACK_OPERATOR_TOKEN` | Bearer token whose hash is configured on Relay |
| `KANVIL_URL` | Cluster-internal Kanvil base URL |
| `KANVIL_INTAKE_KEY` | Create-only `intake` key bound to Talaria Inbox |
| `KANVIL_PROJECT_ID` | Talaria Inbox project ID |
| `SANITIZER_URL` | Cluster-internal base URL of the sanitizer |
| `SANITIZER_TOKEN` | The sanitizer's bearer token; it grants nothing else |
| `RELAY_SYNC_URL` | Optional Convex client URL of the Relay deployment (`https://<deployment>.convex.cloud`); enables watch mode |
| `HEALTH_PORT` | Optional port (1–65535) for watch mode's `/healthz` readiness endpoint |

Use the `intake` scope provided by KAN-67. It forces human triage and disables
automation on created tickets; KAN-77 lets the same key attach files to the
quarantined tickets it created and nothing else. The bridge sends exactly the `user-report`,
trust-tier (`signed-in` for a report from a self-registered server, or `unverified`), and
client-platform labels; Kanvil adds its own `intake` label. The ticket title is `User report: `
plus the submitted title with control characters, backticks and angle brackets removed, at most
120 characters; the description repeats the original title inside a fence.
Credentials stay in the cluster and are never logged. Missing variables (including
`SANITIZER_URL` and `SANITIZER_TOKEN`) or an invalid base URL exit 2 and name only the variable. Queue failures exit 1.
Individual create or acknowledgement failures leave reports pending, continue
with the rest, then exit 1. Each HTTP request has a 30-second timeout and refuses
redirects. A rerun resends the same report request ID and identical ticket input,
so a lost acknowledgement cannot create another ticket. Exit 0 means all
reports in the fetched batch were delivered, or the queue was empty.

The image is `ghcr.io/maudecode/talaria-feedback-bridge`, tagged with the plain
Relay version `X.Y.Z` of the `relay-vX.Y.Z` release that built it; the Relay
release is its only publisher, and the release-set manifest records its digest
(`releases/README.md`). Older `sha-<12-hex>` and `main` tags remain in the
registry but no longer move. Pull requests and main pushes that touch the bridge
build and check it without pushing. `bridge/build-image.sh`, used by both, builds
a linux/amd64 OCI archive, loads those bytes and requires the non-root `node`
user and exit 2 naming `RELAY_URL` when unconfigured. It then starts sanitizer
mode as deployed (read-only root, 256 MB `/tmp`, only its token, an internal
network without outbound access), requires its process to be non-root, and runs
`bridge/smoke.ts` from a second container against it, which proves real sharp and
ffmpeg sanitization, including the synthetic 48 megapixel rotated, GPS-tagged
HEIC in `bridge/fixtures/`. The image adds Alpine's `ffmpeg` package, the pinned
sharp install from `bridge/package-lock.json`, and the entry files.

Deployment is separate. The intended in-cluster shape is two Deployments from the
same pinned versioned image. The bridge runs with one replica, `strategy:
Recreate`, and the variables above supplied from cluster configuration/secrets.
The sanitizer runs `node sanitizer.ts` with the settings under
[Sanitizer](#sanitizer). Without
`RELAY_SYNC_URL` the bridge still runs once per invocation, so a CronJob on
`*/2 * * * *` with `concurrencyPolicy: Forbid` keeps working, with up to two
minutes of delay. Kanvil remains
internal; only the bridge connects outbound to Relay. These source changes do
not configure a deployment or enable Relay's feedback routes.

### Sanitizer

`node sanitizer.ts` is the only process that parses untrusted media, so a
decoder compromise reaches no Relay or Kanvil credential. It serves one
operation: `POST /v1/sanitize?type=<declared type>` with the bearer
`SANITIZER_TOKEN` and the attachment's bytes. It answers 200 with the cleaned
bytes (`content-type` and `x-content-sha256` set) or `{"dropped": <reason>}`.
A wrong token is 401; a body without a length, or over its type's limit in
`contracts/fixtures/feedback-attachment-limits.json`, is 413; a request while
another runs is 503. `GET /healthz` answers 200 for a readiness probe; anything
else is 404. It never logs requests or errors.

| Environment variable | Purpose |
| --- | --- |
| `SANITIZER_TOKEN` | Bearer token the bridge presents; removed from the environment before any decoder starts |
| `SANITIZER_PORT` | Optional listening port, default 8080 |

It refuses to start, exiting 2 and naming only the variable, when any of
`RELAY_URL`, `RELAY_SYNC_URL`, `FEEDBACK_OPERATOR_TOKEN`, `KANVIL_URL`,
`KANVIL_INTAKE_KEY` or `KANVIL_PROJECT_ID` is present. Deploy it as its own
Deployment and Service:

- `command: ["node", "sanitizer.ts"]`, with `SANITIZER_TOKEN` as its only secret.
- `runAsNonRoot: true`, `readOnlyRootFilesystem: true`,
  `allowPrivilegeEscalation: false` and all capabilities dropped.
- An `emptyDir` at `/tmp` with a `sizeLimit` (256Mi covers a 20 MB video and
  its output), plus memory and CPU limits.
- A NetworkPolicy that admits ingress only from the bridge and allows no egress.

## Remaining real-boundary proof

After Apple enables Sign in with Apple for the Talaria App ID and production configuration is installed:

1. Sign in from a physical iPhone.
2. Register an authenticated Hermes server as its owner, then enroll each Hermes profile from Talaria Settings.
3. Start concurrent Hermes sessions and arm the aggregate Live Activity.
4. Lock the phone and verify APNs update/end plus approval/input notification fallback.

See [docs/http-api.md](docs/http-api.md) for the v1 contract.
