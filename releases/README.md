# Release-set metadata

`release-set.schema.json` defines version 1 of the immutable release receipt.
Its identifier is the monorepo source SHA. Each changed component is built from
that SHA; an unchanged component retains its previous tag, artifact, source and
original release-set identifier. Versions are independent. Supported contract
versions are explicit capability sets; peers must share a capability, and the
new servers must still support the previously released App. App and Relay must
support the latest completed Web release in both stable and experimental channels
while installations upgrade. The selected App runs live contract tests against
those retained Web sources; Relay checks their publisher fixtures. Changed components
must advance beyond every published version in their namespace. Web stable and
experimental versions advance independently; switching channels does not reset
that channel's published version history.

New release sources require current main CI evidence. Reused components retain
their authenticated release manifest's evidence when old Actions runs expire.

`release_set.py MANIFEST --previous PREVIOUS --output DESTINATION` validates the
schema and cross-field rules before writing a new file. Omit `--previous` only
for the first release set. Existing output files are never overwritten. The
previous document must come from the trusted completed-release publication.

A `candidate` records the intended App build number, locally built Web image
digest and Relay deployment target. It cannot claim a new Relay deployment or
any publication receipt. A `complete` document additionally requires successful
publication evidence for every changed component and the actual deployed Relay
revision. Unchanged components are not republished. Failed or partial runs must
remain diagnostics; changing `status` alone cannot complete them.

Evidence records identify successful workflow gates and their exact source.
JSON validation checks consistency, not whether a remote job actually ran.
Only the trusted root workflow may assemble and publish the completed receipt
from its own successful jobs. Never use an operator-authored JSON receipt as
authorization to deploy or upload.

The Web image digest is the registry manifest digest, not a mutable tag or Docker
config/image ID. Agent identity contains its exact version and immutable source
SHA or published image digest (or both). It is an external dependency, not a
fourth component. The App marketing version and build number, Web image digest,
and Relay source/deployment identity are the rollback inputs.

Run `scripts/check-releases` for isolated synthetic validation. It installs the
pinned release-tool dependencies in a disposable virtual environment and
requires no accounts, credentials, tags or running services.

The Web updater's publication contract is a GitHub release named
`release-set-<releaseSet SHA>` with a `release-set.json` asset. Prepare it as a
draft; publication of the completed manifest is the final step after component
build, compatibility and publication receipts succeed. Never replace a published
manifest. Component notes and signed tags keep their own App/Web/Relay namespaces.
See [Web update behavior](../web/docs/talaria-updates.md) for authentication and
source-install safety boundaries.

## Runners and handoffs

Every release job runs on a GitHub-hosted runner; the repository is public, so
they cost nothing. Jobs that need Xcode, an iOS simulator or Apple signing run on
`xcode-27` (GitHub's Xcode 27 public-preview image, macOS 27 arm64) and select
Xcode through `.github/actions/setup-xcode`; every other job runs on
`ubuntu-latest` and installs its tools through the `release-python`,
`release-node`, `release-ruby` and `docker-plugins` actions.
`releases/test_publication.py` fails when a release or scheduled workflow moves
a job elsewhere or a macOS job loses its native dependency:

| Workflow | Job | Native dependency |
|---|---|---|
| `fuzz-soak.yml` | `soak` | `xcodebuild test` in the simulator |
| `ui-performance.yml` | `measure` | `xcodebuild test` in the simulator |
| `ios-release-build.yml` | `build` | `xcodebuild archive`, Keychain signing, IPA export |
| `release-set.yml` | `contracts` | compiles and tests the selected App in the simulator against every supported Web |
| `release-set.yml` | `previous-app-contracts` | compiles and tests the previously released App in the simulator |
| `release-set.yml` | `app-dry-build` | unsigned `xcodebuild archive` |

The organization runs at most five macOS jobs at once; a release uses three
(the two contract gates and one App build). They cache the SwiftPM repository
cache; the signed build does not, so the shipped IPA never starts from a cache.

The signed build imports the distribution certificate into a keychain the job
creates under `$RUNNER_TEMP` with a random, masked password, searches it first,
and deletes it in an `always()` step. Provisioning profiles come from
`apple-actions/download-provisioning-profiles`.

The Web contract probe, Docker smoke, release-plan preparation, Web/Relay
fixture suites, Agent verification, Relay/Web builds, publication receipt jobs,
manifest assembly, TestFlight inspection and cutover recovery run on Linux.
The Web image build caches its layers in the GitHub Actions cache
(`type=gha`, scope `talaria-web-release`); `actions/github-script` hands the
runtime token Buildx needs, masked, to that one build step.

One `web-publish` job publishes Web: npm first, through the OIDC token npm
trusted publishing accepts, then the GHCR image once npm's readback matches the
built tarballs. It runs the workflow's own `publish.py`, as Relay does, so a
publication fix applies to an existing release.

Release handoffs are GitHub Actions artifacts of the release run, kept 30 days
(the recovery window). A run step cannot reach the artifact service, so the
seam is split: `artifacts.py put NAME DIRECTORY...` archives each directory as
`$RUNNER_TEMP/release-handoffs/<artifact>/<name>.tar`, where the artifact is
named `handoffs_<run>_<attempt>_<name>[.<name>...]`, and records the SHA-256
with the run, attempt and workflow source (`GITHUB_SHA`) in the job outputs;
the very next step uploads that directory with `actions/upload-artifact` under
the name `put` reported. A job's last `put` reports every handoff the job
staged, so the Web image, the IPA and the dSYMs each travel as their own
artifact and receipt assembly never downloads them. `get` restores only
forwarded producer outputs whose run and source match the current job and whose
attempt is not in the future; it finds the one unexpired artifact of that run
and attempt that holds the name through the REST API, checks that GitHub
attributes it to the same run and source, downloads it with `gh run download`
using the job token (`actions: read`) and checks the archive against the
recorded digest before extracting it with the stdlib `data` filter, so no member
can escape. A missing, expired, ambiguous or changed handoff fails the job; there
is no fallback. `releases/test_publication.py` fails when a `put` is not
uploaded by the next step or a job downloads artifacts without the digest check.
Recovery addresses only the authenticated original `production-cutover` run.

The repository is public, so any signed-in GitHub user can download its
artifacts. Handoffs carry only public build outputs and receipts: the plan,
notes, receipts, npm tarballs, the OCI image that GHCR publishes, and the
App Store-signed IPA and dSYMs. Credentials never enter a handoff. Diagnostics,
the candidate and completed manifests, fuzz results (30 days), UI performance
metrics (30 days) and failed UI performance result bundles (14 days) are plain
artifacts of their run. Each component still has a separate environment and job
token.

## Workflow commands

`cli.py prepare` checks exact-main CI, resolves component tags, generates notes,
and records the previous published App source. Its request contains only
`sourceRevision`, `tags` (App/Web/Relay), and `relayDeploymentId`. A previous
manifest is downloaded with `cli.py previous SHA`; drafts and inconsistent
identities are rejected. Unchanged components retain their complete prior
records and compatibility metadata.

Preparation in dry-run mode may create ephemeral signed tags in a disposable
local clone. These signatures validate the rehearsal only. Production requires
the existing tags' GitHub-verified signatures. Neither mode pushes tags.

`build.py COMPONENT --plan PLAN --output NEW_DIRECTORY` builds without publishing:
an unsigned App archive with verified bundle versions, the Web contracts and
server npm tarballs plus a multi-platform OCI archive, or checked Relay functions validated against an
anonymous local backend. Use an output directory outside the source checkout.
Local execution writes `build-result.json`; Actions execution additionally writes
a receipt tied to the actual run. An unsigned App archive is not an installable
device-validation build.

`build.py web --experimental --output NEW_DIRECTORY` packs only the Web npm
package for the Experimental channel from `HEAD`, without a plan or Docker image:
version `<latest web-v tag>-exp.<12-hex source>`, tag `web-exp-v<version>`, and
the contracts package bundled so installs never look it up. `experimental.py push
BUILD_DIRECTORY` pushes that tarball to `ghcr.io/maudecode/talaria-web-experimental`
as `sha-<source>`. `experimental.py advance SOURCE` moves `experimental` forward to the newest
published `sha-` commit on `main`, never behind its current revision, then keeps the newest 50 package versions plus
the `experimental` target. The `web-experimental.yml` workflow runs them after each
passing `main` push that changes Web or contracts; only `advance` is serialized.

`cli.py gate` writes a success receipt only after its supplied validation command
succeeds. `cli.py assemble` combines receipts and notes; failed/missing gates,
changed artifact identities, and attempted completion of dry-run plans fail.

For previous-App verification, root `scripts/check-previous-app.py --app-ref REF
--web-ref REF --output NEW_DIRECTORY` starts the selected Web in isolated state,
exports live responses, and compiles the actual older App from Git. It verifies
the fixtures reached the test bundle and retains structured XCTest results.

## Root workflow

Release in one step (TAL-336): sign and push one tag on a green `main` commit.

```sh
git tag -s v1.10.1 <main commit> -m "Talaria 1.10.1" && git push origin v1.10.1
```

Only organization admins can create `v*` tags, and release tags are immutable,
so the signed root tag is the release authorization. `release.yml` then:

1. verifies the tag's GitHub signature and that its commit is on `main`;
2. waits for that commit's `main` CI;
3. reads the latest published release set and selects the components whose
   `app/`, `web/` or `relay/` sources changed since their released source;
4. creates `<component>-vX.Y.Z` tags at the same commit for the changed
   components (unchanged ones keep their previous tags); `validate_release_tag`
   accepts these because the signed root `vX.Y.Z` sits on the same commit;
5. starts `production-cutover.yml` on `main` with the resulting request and
   `confirm_publication=true`.

The whole release shares one version. A version is used once: if a release
fails and needs a code fix, push the next patch version.

The cutover takes a JSON `request` with this shape, which `release.yml` builds;
direct dispatches (and `release-set.yml` dry runs) use the same shape:

```json
{
  "sourceRevision": "<40-character main commit SHA>",
  "tags": {"app": "app-v1.10.1", "web": "web-v1.10.1", "relay": "relay-v0.2.0"},
  "relayDeploymentId": "<existing production deployment ID>"
}
```

`previous_release_set` is the last completed set's SHA; empty only for
bootstrap. Preparation checks all published root releases and rejects a missing
or stale predecessor once a release set exists. Changed tags must point to
`sourceRevision`; unchanged tags must match the previous manifest.

The cutover repeats every gate (selected-source and previous-App contracts,
pinned Agent compatibility, component builds), then deploys Relay, publishes
Web and uploads the App in that order, and publishes the manifest last.
A `release-set.yml` dispatch with `dry_run=true` rehearses the same gates without
publication credentials when a change to the release tooling needs it.
Unchanged components skip their build/publication jobs. Required
jobs that fail, cancel or unexpectedly skip block completion.

Credentials are scoped to jobs: `relay-production` supplies the matching
production deployment key, `web-release` authorizes the `web-publish` job whose
OIDC token npm trusts and whose job token writes the GHCR image, `testflight` supplies Apple signing/upload credentials, and
`release-set-publication` grants the job's release-write token. These
environments must allow the trusted `main` workflow.

`@maudecode/talaria-web-contracts` and `@maudecode/talaria-web` trust GitHub
organization `MaudeCode`, repository `talaria`, workflow
`production-cutover.yml`, environment `web-release`, with direct publishing
allowed. Production releases use no long-lived npm token. The caller and
reusable release jobs both grant `id-token: write`; npm publication needs a
GitHub-hosted runner because self-hosted OIDC publishing is unsupported.

The root manifest is published last. Fresh dispatches require unused component
release names. If only the final `publish-set` job fails, use **Re-run failed
jobs** on that same Actions run. It verifies the original manifest fingerprint,
notes and asset checksums before reusing matching component/root releases,
finishing missing draft uploads and publishing the root last. Conflicting
records are rejected; published assets are never overwritten.

The App publication job also supports **Re-run failed jobs** on the same run.
It verifies the retained IPA's local SHA-256 and resumes the existing Apple
upload only when its hash-named remote file, size, type, app/version/build and
upload identity match. Apple rejects optional checksum declarations on commit;
the helper follows Apple's native `uploaded: true` request. If Apple returns a
per-file MD5 or SHA-256 checksum, it must match the retained IPA. When that
optional field is absent, recovery relies on the authenticated upload identity;
it does not verify the remote bytes against an Apple-attested digest.
The receipt's `ipaSha256` identifies the locally verified/transmitted artifact.
Both file delivery and the matching build's `VALID` processing state must pass
before writing a receipt. A lost upload response,
processing timeout, or receipt/handoff failure does not upload a duplicate build.
Ambiguous records, mismatched supplied checksums, failed processing, and unverified existing
builds fail closed. Apple build/upload IDs are retained in `apple-build.json`
and the job log; successful cleanup retains this small publication evidence.
The helper uses Apple's [build-upload API](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads).
API tokens renew during the processing wait; signing keys stay
in a private temporary file and never reach the asset-upload host.

If a reviewed publishing-tool fix is needed after all three component builds
and Relay/Web publication succeeded, use the **Recover failed cutover App
publication** workflow on main. Supply the original production-cutover run and
attempt, and explicitly confirm publication. It authenticates the original
GitHub job results, downloads that run's handoff artifacts with the recovery
job's token and checks each against its recorded hash, checks that the release is still current, and
resumes the same IPA/upload using reviewed publishing tools. Release handoffs expire
after 30 days, so recovery must start within that window.
Original receipts keep their original run URLs; resumed upload evidence names
the actual recovery run. It neither rebuilds the App nor republishes Relay/Web.
Missing, changed, or incompatible original evidence fails closed. After a
recovery run starts publication, retry its failed jobs on that same run.

Inspect Relay/Web deployment side effects before retrying their failed jobs.
A fresh dispatch or **Re-run all jobs** can create new build identities and is
not a recovery path for partially published releases.
Never describe a partial run as complete. Retain the previous manifest's
component identities for rollback.
