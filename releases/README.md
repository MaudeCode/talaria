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

Every job in every workflow runs on a GitHub-hosted runner; the repository is
public, so they cost nothing. Jobs that need Xcode, an iOS simulator or Apple
signing run on `xcode-27` (GitHub's Xcode 27 public-preview image, macOS 27
arm64) and select Xcode through `.github/actions/setup-xcode`; every other job
runs on `ubuntu-latest` and installs its tools through the `release-python`,
`release-node`, `release-ruby` and `docker-plugins` actions.
`scripts/check-hosted-runners.py` fails when any job, for any event, can resolve
to another runner, a workflow references the retired NAS credentials, or a
third-party action (also inside a local composite action) is not pinned to a
full commit SHA; its test fails when a macOS job appears or loses its native
dependency:

| Workflow | Job | Native dependency |
|---|---|---|
| `app-tests.yml` | `app-build` | `app/ci/build-for-testing` once, uploaded as the `app-test-build` artifact for the test job |
| `app-tests.yml` | `app-test` | `xcodebuild test-without-building` in the simulator: the hosted unit tests (TalariaTests) in four class shards (`app/ci/hosted-test-shard`) on pull requests, main pushes and at release |
| `app-tests.yml` | `package-test` | `swift test` for TalariaKit (every native contract class and the live Web contract test); a release's hosted-tests call leaves it to `contracts` |
| `ci.yml` | `app-tooling` | exercises the macOS `lockf`/`simctl` runner scripts with fakes |
| `fuzz-soak.yml` | `soak` | `swift test` for TalariaKit's fuzz soak class |
| `ios-release-build.yml` | `build` | `xcodebuild archive`, Keychain signing, IPA export |
| `release-set.yml` | `contracts` | both App contract gates at once: the selected App against every supported Web, plus its whole TalariaKit suite when it ships, and the previously released App against the selected Web; `swift test`, or the simulator for an App from before TAL-399 |
| `release-set.yml` | `app-dry-build` | unsigned `xcodebuild archive` |

A release that ships the App needs the App's simulator-hosted unit tests to
have passed on the exact release source, dry runs included (TAL-1550).
`release.yml` already waited for main CI on that commit, so
`app-hosted-tests-lookup` (`app/ci/find-hosted-tests-run`) looks for a
completed, successful main-push CI run of `ci.yml` on exactly that SHA whose
`App / App hosted tests` job succeeded, and records that job's URL in the
summary. Only then is `app-hosted-tests` (`app-tests.yml` in pull-request mode:
the App build and four TalariaTests shards) skipped; otherwise it runs. Main CI
leaves out the App jobs when a push does not touch the App, so a release on such
a commit tests again. Runs on other commits never count, and a lookup that
fails or errors skips the suite and fails `build-gate` rather than counting as
reuse. `build-gate` requires the lookup to succeed when the App ships and
exactly one of reuse (the suite skipped) or a successful suite run.

`app-tests.yml` splits TalariaTests by class into four simulator jobs that
share the one build (`app/ci/hosted-test-shard`): three fixed, measured sets of
the slowest classes and a last shard that runs every other class, so a new
class always runs. Its `App hosted tests` job then requires each shard's list
of the classes it ran to show every class exactly once. The split comes from
the class times main CI run 41114665116 measured (1433 s of tests), which the
script records: SessionList (362 s), Chat (354 s), Transcript with Stream
(353 s) and every other class (363 s). `hosted_test_shard_test.py` fails when
the recorded times leave a shard more than 90 s over the mean. Each shard job
boots its simulator while the build runs, then prepares it in the background
(`ci/background`) while it waits for and downloads the build. Booting and
preparing took 3 to 8 minutes on hosted runners, mostly the notification
service's restarts, so a shard job takes about 6 minutes of tests plus that.
The App package tests start once the build ends, so the build and the four
shards fill the five macOS slots.

The pinned Agent gate runs one `agent-release` job per supported Agent release
of the selected Web source and shard of its sidecar suite: three shards each,
nine jobs (TAL-1550, TAL-1599). `prepare` lists them
(`scripts/check-release-agent.py --list`). A release that retains a Web release
from before TAL-1599 checks the Agents against that source's own checker,
which cannot shard, so each release then runs whole in one job and `agent`
requires its one passing receipt. Each job provisions its release,
runs the Agent probe, verifies the release image beside the tests, and runs
its shard's cases with the runner's whole worker budget (`--release --shard`).
The suite runner deals each layer's cases round-robin in collection order, so
a slow module's cases spread over the shards. Each job writes its gate receipt
through `cli.py gate` and its compatibility receipt, with the cases it ran and
the digest of the suite they were dealt from, and uploads both. `agent`
gathers this run's receipts (`artifacts.py gather`; a rerun keeps the shards
that passed before) and writes the one `agentCompatibility` receipt the
manifest records only when the jobs are exactly the supported releases'
shards (`--expect`), every shard's newest receipt in this run passed with the
image verified on the selected source, and each release's shards ran every
one of its sidecar test cases exactly once. A failed shard skips `agent`,
which fails `build-gate`. The check prints each phase's start time to the job
log as it runs. Before the shards, one release took 17 to 19.5 minutes (cutover
run 40795594849): 16 minutes in the suite, with one diagnostic probe alone
waiting about 4 minutes on its never-answering MCP server.

The organization runs at most five macOS jobs at once. A release that reuses
main CI's hosted tests needs two:

- `contracts` runs both App contract gates on one runner, at once, each with its
  own receipt. With `swift test` they took 9 minutes together in release run
  40498046778; with an App from before TAL-399, which builds and tests in the
  simulator, longer.
- The package tests run in `contracts` instead of on another runner:
  `contracts` already builds the release source's TalariaKit tests, so the whole
  package suite adds about 30 seconds there (`--package-suite`).
- The App build (signed, or `app-dry-build` on a dry run) starts with the gates.
- When the hosted tests run, their build and four shards need five more. The
  shards queue once the build holds a runner (TAL-413) and boot while it
  builds; whichever do not fit start as `contracts` and the App build free their
  slots.
- The signed build cannot reuse the hosted tests' compiled work: one is a
  Release archive for devices signed for distribution, the other a Debug build
  for the simulator, signed ad hoc with the `.xctest` identifier suffix, so no
  compiled file is valid for both.

The planned critical path of a release that reuses main CI's hosted tests, in
minutes from the cutover run's start (the tag push is about a minute earlier
when main CI on the tag commit is already green). The times come from the
measured jobs of cutover run 40795594849 and the sharded Agent gate's plan;
the `timeline` job measures each run:

| Time | Event |
|---|---|
| 0:00-2:10 | `authorization`, then `prepare` (plan and the Agent jobs) |
| 2:10 | every gate and build starts; `app-hosted-tests-lookup` finds main CI's hosted tests within a minute |
| 8:50 | `contracts` done; the signed App build at 10:45 |
| about 10:00 | the slowest `agent-release` shard done (setup, the selected server build, provisioning and the probe, then its third of the suite beside the image check); `agent` about 0:40 later |
| 11:25 | `web-build` done, the last gate or build |
| 11:40 | `build-gate` done; `relay-publish` starts (about 0:50) |
| 12:35 | `web-publish` (about 7:45, npm publication and readback 5:55) and `app-publish` (about 5:15) start |
| 21:25 | `publish-set` published the manifest (about 22 minutes after the tag push) |

`web-build` and the publication jobs are now the critical path: the 20-minute
target of TAL-414 also needs `web-build` or `web-publish` shortened. Queue time does not count
toward a job's timeout. A release may overlap pull-request CI, and whichever
macOS jobs then do not fit start as slots free up. A job that holds a macOS
slot never waits for a queued macOS job, so the plan cannot deadlock. The
`timeline` job writes every job's queue, start and finish time into the step
summary, and the publication jobs and `contracts` record
their phases (npm publish and readback, GHCR copy, TestFlight transfer and
processing, Web probe, builds and simulator boot) there too, so each dry run
and release measures this plan. Every simulator job uses the image's
own iPhone 17 on the runtime matching the selected Xcode's SDK, as `ci.yml`
does: the App hosted tests boot it with the pinned
`futureware-tech/simulator-action` and run plain `xcodebuild`; the contract
gates hand its identifier to the tested App's own `scripts/test-ios`
(`IOS_SIMULATOR_ID`), which boots, uses and shuts down that one device for each
App/Web pair, so no simulator pool is set up. No macOS job restores a build or
package cache: CI measured hosted-macOS cache restores slower than cold builds.

The signed build imports the distribution certificate into a keychain the job
creates under `$RUNNER_TEMP` with a random, masked password, searches it first,
and deletes it in an `always()` step. Provisioning profiles come from
`apple-actions/download-provisioning-profiles`.

CI's Web contract probe uploads its live responses as the run's
`contract-fixture` artifact for the App package tests (see
[contract validation](../CONTRACT_TESTS.md)); the Web end-to-end suite runs in
six Playwright shards and the Docker smoke in one job per Compose variant
(five). Release-plan preparation, Web/Relay fixture suites, Agent verification,
Relay/Web builds, publication receipt jobs, manifest assembly, TestFlight
inspection and cutover recovery run on Linux too.
The Web image build caches its layers in the GitHub Actions cache
(`type=gha`, scope `talaria-web-release`); `actions/github-script` hands the
runtime token Buildx needs, masked, to that one build step.

One `web-publish` job publishes Web: npm first, through the OIDC token npm
trusted publishing accepts, then the GHCR image once npm's readback matches the
built tarballs. It runs the workflow's own `publish.py`, as Relay does, so a
publication fix applies to an existing release.
Between the two, the workflow's own `smoke_npm.py` installs the published
`@maudecode/talaria-web@<version>` and requires it to boot; a failure stops the
job, so `publish-set` never completes the set and no updater offers it.

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

`smoke_npm.py SPEC` installs an npm spec (a tarball path or
`@maudecode/talaria-web@<version>`) with the updater's `npm install --global
--prefix` command, starts its bin in the foreground with the e2e suite's isolated
environment and the package's own replay sidecar, and fails with the server log
tail unless `/health` answers 200 within 60 seconds.

`build.py COMPONENT --plan PLAN --output NEW_DIRECTORY` builds without publishing:
an unsigned App archive with verified bundle versions, the Web contracts and
server npm tarballs plus a multi-platform OCI archive, or checked Relay functions validated against an
anonymous local backend. Use an output directory outside the source checkout.
Local execution writes `build-result.json`; Actions execution additionally writes
a receipt tied to the actual run. An unsigned App archive is not an installable
device-validation build.

Every App and Web build, including the signed production and Nightly App builds,
stamps through `scripts/stamp-release.py`, which also packages the release's
What's New announcement generated from its fragments: the App's Info.plist
`TalariaWhatsNew` string and Web's `_whats_new.json`. A release whose fragments
announce nothing packages none. See `app/docs/release-notes.md`.

`build.py web --experimental --output NEW_DIRECTORY` packs only the Web npm
package for the Experimental channel from `HEAD`, without a plan or Docker image:
version `<latest web-v tag, patch + 1>-exp.<12-hex source>`, tag `web-exp-v<version>`, and
the contracts package bundled so installs never look it up. The bundle also carries
each direct dependency the contracts closure peer-depends on (`ws`), which npm would
otherwise install as an empty directory. Before writing `build-result.json` it runs
`smoke_npm.py` on the final tarball. `experimental.py push
BUILD_DIRECTORY` pushes that tarball to `ghcr.io/maudecode/talaria-web-experimental`
as `sha-<source>`. `experimental.py advance SOURCE` moves `experimental` forward to the newest
published `sha-` commit on `main`, never behind its current revision, then keeps the newest 50 package versions plus
the `experimental` and `nightly` targets. The `web-experimental.yml` workflow runs them after each
passing `main` push that selects a Web suite (`web_server`, `web_frontend`, or `web_sidecar`), which shared contract
changes also select; only `advance` is serialized.

The Nightly channel sits between Experimental and Stable. `nightly.yml` targets 03:07 `America/New_York` daily
(and also accepts dispatch), preserving local time across daylight saving changes. An external T3 task checks at 03:37 Eastern and dispatches the workflow on `main` only
when that day's Nightly run is missing and no earlier Nightly is still active. Queued runs count as present; API
lookup failures never trigger a dispatch. Both schedules require their scheduler to be available.

For each run, `nightly.py select` picks the newest `main` commit whose push CI passed after the `nightly` git tag, and does
nothing new when there is none, or while a production cutover is queued or running. `experimental.py advance SOURCE
--tag nightly` then moves the forward-only `nightly` GHCR tag to the newest Experimental build on that commit's history,
so Nightly reuses the Experimental artifact; it runs even when no new commit was selected, so a build published after
its source was recorded still reaches Nightly. The App build rechecks for a cutover once it holds the
`talaria-testflight-publication` queue, so the two never pick the same build number.
When `scripts/changed-components.py` selects the App since the last Nightly, `ios-release-build.yml` with
`channel: nightly` builds it as the next patch after the latest `app-v` tag, and `nightly.py upload` sends it to
TestFlight internal testing through the same upload and `VALID` readback as production. Only after both succeed
does `nightly.py record` move the `nightly` git tag, so a failed run is retried the next night.

`cli.py gate` writes a success receipt only after its supplied validation command
succeeds. `cli.py assemble` combines receipts and notes; failed/missing gates,
changed artifact identities, and attempted completion of dry-run plans fail.

For previous-App verification, root `scripts/check-previous-app.py --app-ref REF
--web-ref REF --output NEW_DIRECTORY` starts the selected Web in isolated state,
exports live responses, and compiles the actual older App from Git. It verifies
the fixtures reached the test bundle and retains structured XCTest results. For an
App revision with the TalariaKit package (TAL-399), the contract classes that live
there run with `swift test` against the same responses, and the live decoding test
must pass there instead; their build runs while the Web is probed (TAL-408).
An older App with an explicit `IOS_SIMULATOR_ID` boots that simulator and
compiles its hosted tests (the settings of its own `test-ios`, with a
placeholder fixture) while the Web is probed; its `test-ios` then only rewrites
the Info.plists with the live fixture and re-signs before testing (TAL-414).
Measured locally on `fa370fac`, the gate took 80 s instead of 126 s, and
`test-ios` 13 s instead of 61 s; on a hosted runner the build, about 7.5 of the
13 minutes, no longer waits for the probe and the boot. `--package-suite` also
runs every TalariaKit test but the fuzz soak against the live fixture.

## Root workflow

Release in one step (TAL-336): sign and push one tag on a green `main` commit.

```sh
git tag -s v1.10.1 <main commit> -m "Talaria 1.10.1" && git push origin v1.10.1
```

Only organization admins can create `v*` tags, and release tags are immutable,
so the signed root tag is the release authorization. `release.yml` then:

1. verifies the tag's GitHub signature and that its commit is on `main`;
2. waits for that commit's `main` CI, failing as soon as that run fails; rerun
   its failed jobs (`gh run rerun <id> --failed`), then rerun the release run,
   which revalidates the same tag;
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
the App's hosted unit tests on the release source when the App ships, reused
from main CI when it already passed them there, pinned Agent compatibility, one
job per supported release, component builds), then deploys Relay, publishes Web and
uploads the App at once, and publishes the manifest last. Nothing publishes
before `build-gate` has every gate and build. The ordering keeps only the
constraints that hold (TAL-414):

- Relay deploys before Web and the App publish. Preparation checks that the new
  Relay serves the previous Web and App, and the contract gates test the new
  Web and App against the new Relay's fixtures, but nothing tests them against
  the previous Relay, which serves them until the deployment succeeds.
- Web and the App publish at once. The App was tested live against every
  supported Web, the latest completed Web releases included, and the Web
  against the previous App (`previousAppContracts`); neither needs the other
  published, and installations upgrade their Web on their own schedule anyway.
  The TestFlight upload, whose processing to `VALID` is the longest publication,
  therefore starts right after the Relay deployment.
- The manifest publishes last, only after every selected publication read back
  (`check_results.py publication`): the Web updater reads only that manifest.
  The component releases are drafts until then.

Publication is fail-closed rather than all-or-nothing: a failed Relay
deployment stops Web and the App before they publish, but Web and the App no
longer stop each other. Either can then be public without the manifest, and
both work with the released peers. **Re-run failed jobs** on the same run
retries the failed one, whose retry accepts the identical bytes already
published, and then `publish-set`. The App-only recovery workflow still covers
a failed App upload after Relay and Web succeeded.
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
