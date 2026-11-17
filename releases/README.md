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

A new release set's evidence is its own run's gate receipts. Sets published
before TAL-2396 also carry a `mainCI` receipt, which still validates but is no
longer required. Reused components retain their authenticated release
manifest's evidence when old Actions runs expire.

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

A changed Relay also records `bridgeImage`: the feedback bridge image its
release built and published, `ref` `ghcr.io/maudecode/talaria-feedback-bridge:X.Y.Z`
at Relay's plain version and `digest` its registry manifest digest. Evidence
then includes `buildBridge` and, in a `complete` document, `publishBridge`.
Sets published before the bridge joined the release carry neither.

Run `scripts/check-releases` for isolated synthetic validation. It installs the
pinned release-tool dependencies in a disposable virtual environment and
requires no accounts, credentials, tags or running services.

The Web updater's publication contract is a GitHub release named
`release-set-<releaseSet SHA>` with a `release-set.json` asset. Prepare it as a
draft; publication of the completed manifest follows component build,
compatibility and publication receipts, and only the version tags follow it. Never replace a published
manifest. Component notes and tags keep their own App/Web/Relay namespaces.
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
| `app-tests.yml` | `app-build` | `app/ci/build-for-testing` once; in hosted mode, uploaded as the `app-test-build` artifact for the test job, then `swift test` for TalariaKit on the same runner (a release's hosted-tests call leaves that to `contracts`) |
| `app-tests.yml` | `app-test` | `xcodebuild test-without-building` in the simulator: the hosted unit tests (TalariaTests) in four class shards (`app/ci/hosted-test-shard`) on main pushes, manual runs, at release and on pull requests labelled `hosted-tests` |
| `app-tests.yml` | `package-test` | `swift test` for TalariaKit (every native contract class and the live Web contract test) in build and contracts modes |
| `ci.yml` | `app-tooling` | exercises the macOS `lockf`/`simctl` runner scripts with fakes |
| `ios-release-build.yml` | `build` | `xcodebuild archive`, and signing, IPA export and verification through the shared `ios-signing` and `ios-publish` actions |
| `release-set.yml` | `contracts` | both App contract gates at once: the selected App against every supported Web, plus its whole TalariaKit suite when it ships, and the previously released App against the selected Web; `swift test`, or the simulator for an App from before TAL-399 |
| `release-set.yml` | `app-dry-build` | unsigned `xcodebuild archive` |
| `release-set.yml` | `app-publish` | the shared `ios-publish` action, which verifies the IPA (`codesign`, `plutil`, `security cms`) before it uploads |
| `recover-cutover.yml` | `app` | the same `ios-publish` verification and upload, resuming the original IPA |

No release waits for main CI (TAL-2396). Each component a release ships needs
its own suite to have passed on the exact release source, dry runs included: the
App's simulator-hosted unit tests (TAL-1550), Web's server suite on every
storage backend with its frontend checks and Playwright shards, and Relay's
suite. `production-cutover.yml` names every job of those suites in main CI in
the shared `release-preflight`'s `checks` input (`ci.yml: <job name>`), and
preflight reports which of them already succeeded in the newest ci.yml push run
on the commit. A job that passed counts even when a sibling failed; one that is
running, skipped or absent does not, and nothing waits for it. Web has no single
job for its suite, so every server and frontend job is named, and
`test_publication.py` keeps that list equal to `web-verify.yml`'s matrices; its
sidecar matrix is left out because the Agent gate runs it against every
supported Agent release. `prepare` reuses a suite only when every one of its
named jobs passed (`check_results.py reused`), which skips that suite's release
job: `app-hosted-tests` (`app-tests.yml` in hosted mode: the App build and four
TalariaTests shards), `web-tests` (`web-verify.yml` without the sidecar matrix)
or `relay-tests` (`relay-verify.yml`), each at the selected commit. Otherwise
the release runs it. A dry run of `release-set.yml` reuses nothing. `build-gate`
requires, for each component that ships, exactly one of reuse (its suite
skipped) or a successful suite run. Every other check runs in the release
itself; a new dispatch repeats them, so compatibility is always verified against
the peers that run's plan selected.

`app-tests.yml` splits TalariaTests by class into four simulator jobs that
share the one build (`app/ci/hosted-test-shard`): three fixed, measured sets of
the slowest classes and a last shard that runs every other class, so a new
class always runs. Its `App hosted tests` job then requires each shard's list
of the classes it ran to show every class exactly once. The split comes from
the class times PR CI run 41980667369 measured (1289 s of tests), which the
script records: SessionList with Transcript (267 s), Chat with Insights (300 s),
Stream with SessionActions and RegularSplit (318 s) and every other class
(404 s). `hosted_test_shard_test.py` fails when
the recorded times leave a shard more than 90 s over the mean. Each shard job
boots its simulator while the build runs, then prepares it in the background
(`ci/background`) while it waits for and downloads the build. Booting and
preparing took 3 to 8 minutes on hosted runners, mostly the notification
service's restarts, so a shard job takes about 6 minutes of tests plus that.
In hosted mode the build job runs the package tests after its upload, so the
shards never wait on them, and the build job and the four shards fill the five
macOS slots. A pull request without the `hosted-tests` label takes two slots:
the build and the package tests, side by side, and no shards.

The pinned Agent gate runs one `agent-release` job per supported Agent release
of the selected Web source and shard of its sidecar suite: three shards each,
nine jobs (TAL-1550, TAL-1599). `prepare` lists them
(`scripts/check-release-agent.py --list`). A release that retains a Web release
from before TAL-1599 checks the Agents against that source's own checker,
which cannot shard, so each release then runs whole in one job and `agent`
requires its one passing receipt. Each job provisions its release,
runs the Agent probe, verifies the release image beside the tests, and runs
its shard's cases with the runner's whole worker budget (`--release --shard`).
The suite runner deals each layer's cases by their recorded duration
(`web/sidecar/tests/case_durations.json`), so a release's shards take about the
same time. Each job writes its gate receipt
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

The organization runs at most five macOS jobs at once, shared with other work,
so a release runs at most three (TAL-2396). Job dependencies and the shards'
matrix width enforce it; nothing watches the queue, and pull-request CI keeps its
own selection and width. `test_publication.py` checks every route:

- `contracts` runs both App contract gates on one runner, at once, each with its
  own receipt. With `swift test` they took 9 minutes together in release run
  40498046778; with an App from before TAL-399, which builds and tests in the
  simulator, longer.
- The package tests run in `contracts` instead of on another runner:
  `contracts` already builds the release source's TalariaKit tests, so the whole
  package suite adds about 30 seconds there (`--package-suite`).
- The App build (signed, or `app-dry-build` on a dry run) starts with the gates:
  two macOS jobs.
- When the hosted tests run, they start once `contracts` and the App build both
  succeeded: their build and two shards at a time (`shards_at_once: 2`), three
  macOS jobs. A failed gate or build skips them, since the release fails anyway.
- `app-publish` follows `build-gate`, alone.
- The signed build cannot reuse the hosted tests' compiled work: one is a
  Release archive for devices signed for distribution, the other a Debug build
  for the simulator, signed ad hoc with the `.xctest` identifier suffix, so no
  compiled file is valid for both.

A pre-test runner fault is retried inside its shard (`scripts/xctest-launch`);
a failing assertion fails the attempt. Nothing re-runs a release by itself: the
operator may re-run its failed jobs on the same commit, and a source fix is a
new commit and a new dispatch.

The planned critical path of a release that reuses main CI's hosted tests, in
minutes from the start of the release workflow's `prepare` job. The times come from the
measured jobs of cutover run 40795594849 and the sharded Agent gate's plan;
the `timeline` job measures each run:

| Time | Event |
|---|---|
| 0:00-2:10 | `prepare` (plan and the Agent jobs) |
| 2:10 | every gate and build starts; `prepare` already found main CI's hosted tests |
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

CI's Web contract probe uploads its live responses, and each retained Web
release's, as the run's `contract-fixture` artifact for the App package tests
(see [contract validation](../CONTRACT_TESTS.md)); the Web end-to-end suite runs
in six Playwright shards and the Docker smoke in one job per Compose variant
(six), beside a job that cross-builds the image's Node stage for arm64, as the
release's two-platform build does. Release-plan preparation, Web/Relay fixture suites, Agent verification,
Relay/Web builds, publication receipt jobs, manifest assembly, TestFlight
inspection and cutover recovery run on Linux too.
The Web image build caches its layers in the GitHub Actions cache
(`type=gha`, scope `talaria-web-release`); `actions/github-script` hands the
runtime token Buildx needs, masked, to that one build step.

`bridge-build` builds the feedback bridge image in its own job beside
`relay-build`, so it never lengthens it. `bridge-publish` copies those OCI bytes
to `ghcr.io/maudecode/talaria-feedback-bridge:<Relay X.Y.Z>` after the Relay
deployment, beside `web-publish` and `app-publish`, with its own
`packages: write` job token; no build job holds that permission. Web and the bridge share `publish.py`'s
`publish_image`: GHCR tags are immutable, so a tag that already serves the
built digest is left alone on a retry and one serving another manifest fails
the job; the tag is then read back at the built digest. The release is the only
publisher of the bridge image; `relay-bridge-image.yml` builds and checks it on
pull requests and main pushes without pushing.

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
staged, so the Web and bridge images, the IPA and the dSYMs each travel as their own
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
notes, receipts, npm tarballs, the OCI images that GHCR publishes, and the
App Store-signed IPA and dSYMs. Credentials never enter a handoff. Diagnostics,
the candidate and completed manifests, fuzz results (30 days), UI performance
metrics (30 days) and failed UI performance result bundles (14 days) are plain
artifacts of their run. Each component still has a separate environment and job
token.

## Workflow commands

`cli.py prepare` checks that the source is on `main` after the last release set, plans the component versions, generates notes,
and records the previous published App source. Its request contains only
`sourceRevision`, `tags` (App/Web/Relay), and `relayDeploymentId`. A previous
manifest is downloaded with `cli.py previous SHA`; drafts and inconsistent
identities are rejected. Unchanged components retain their complete prior
records and compatibility metadata.

Preparation creates no tag in either mode. A changed component is planned from
`sourceRevision` alone; its tag must not exist yet, except at that commit from an
earlier attempt. An unchanged component's tag must still name its released source.

`smoke_npm.py SPEC` installs an npm spec (a tarball path or
`@maudecode/talaria-web@<version>`) with the updater's `npm install --global
--prefix` command, starts its bin in the foreground with the e2e suite's isolated
environment and the package's own replay sidecar, and fails with the server log
tail unless `/health` answers 200 within 60 seconds.

`build.py COMPONENT --plan PLAN --output NEW_DIRECTORY` builds without publishing:
an unsigned App archive with verified bundle versions, the Web contracts and
server npm tarballs plus a multi-platform OCI archive, or checked Relay functions validated against an
anonymous local backend. `build.py bridge` builds Relay's feedback bridge as a linux/amd64 OCI archive through
`relay/bridge/build-image.sh`, which loads those exact bytes and requires a non-root user, exit 2 naming `RELAY_URL`
when unconfigured, and the `smoke.ts` sanitization check; the receipt records `bridgeImage` with its digest. Use an output directory outside the source checkout.
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
passing `main` push whose diff from `experimental.py base` (the revision `experimental` names, or the push's base
while the tag is missing) changes the Web artifact, so a Web change whose own CI failed ships with the next green
commit. `changed-components.py --web-artifact` decides: any Web suite (`web_server`, `web_frontend`, or
`web_sidecar`, which shared contract changes also select), a release fragment with a `web` entry, or a What's New
stamp input. Only `advance` is serialized.

The Nightly channel sits between Experimental and Stable. `nightly.yml` has no GitHub cron: the external GitHub
Scheduler service (`MaudeCode/github-scheduler`) dispatches it daily on `main`, and that service holds the schedule. A
manual dispatch on `main` works the same way.

For each run, `nightly.py select` picks the newest `main` commit whose push CI passed after the `nightly` git tag, and does
nothing new when there is none, or while a production cutover is queued or running. `experimental.py advance SOURCE
--tag nightly` then moves the forward-only `nightly` GHCR tag to the newest Experimental build on that commit's history,
so Nightly reuses the Experimental artifact; it runs even when no new commit was selected, so a build published after
its source was recorded still reaches Nightly. The App build rechecks for a cutover once it holds the
`talaria-testflight-publication` queue, so the two never pick the same build number.
When `scripts/changed-components.py` selects the App since the last Nightly, `ios-release-build.yml` with
`channel: nightly` builds it as the next patch after the latest `app-v` tag, `nightly.py verify` checks its Nightly
identity and writes its notes, and the shared `ios-publish` action sends it to TestFlight internal testing through the
same upload and `VALID` readback as production. Only after both succeed does `nightly.py record` move the `nightly`
git tag, so a failed run is retried the next night.

Signing, the build number, the IPA export and its verification, and the upload come from the shared `ios-signing`,
`ios-build-number` and `ios-publish` actions in `MaudeCode/.github` (its `IOS.md`), pinned by commit and reading the
organisation's signing secrets. The build number is App Store Connect's highest for the version plus one; a re-run for
the same version and commit gets the number it already uploaded. Nightly numbers and uploads as its own `nightly`
variant, because it stamps a different identity into the same commit's app than production does. A production
upload runs in `app-publish` only after `publish.py verify-app` has authorized the trusted main cutover, matched the
IPA to its build receipt and written its notes; `publish.py app` then records the build `ios-publish` read back
`VALID`. Both channels write the App's release notes since the highest lower `app-v` tag
(`app/ci/release_notes.py testflight`), which `ios-publish` sets as the build's en-US TestFlight "What to Test" text
once the build is `VALID`, updating an existing en-US localization rather than adding another, so a retried run stays
idempotent. Uploading the same version and build number again is success, so a re-run never uploads twice. Notes need
the source's tags, so every upload job checks out full history. A recovery runs the reviewed `publish.py` and notes
generator that `recover-cutover.yml` archives, against the older source. Dispatching `ios-release-build.yml` with a
commit and a version is a signing check: it builds, signs and verifies the IPA without an environment, a release plan
or an upload. See [TestFlight What to Test](../app/docs/release-notes.md#testflight-what-to-test) for the text's format.

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
runs every TalariaKit test against the live fixture.

## Root workflow

Release by dispatching `production-cutover.yml` (titled **Release**) on `main`,
following the shared tag-last contract in `MaudeCode/.github`'s `RELEASES.md`
(TAL-2342). The GitHub Scheduler's Releases page dispatches it; from a terminal:

```sh
gh workflow run production-cutover.yml --repo MaudeCode/talaria --ref main -f tag=v1.10.1
```

A release is `(tag, sha)`. `sha` is optional: left empty, the release is of
`main`'s head when the run started; given, it is any commit on `main` after the
last release. The run stays on that commit whatever merges afterwards: every job
reads it from preflight's `sha` output, never `github.sha`, which is the workflow
revision. The workflow revision runs the orchestration and names the run; the
selected commit is what is checked out, verified, built, recorded in the
manifest and tagged. The run, titled `Release v1.10.1`:

1. `preflight` runs `release-preflight` (pinned to a full commit SHA), which
   refuses anything but a dispatch on `main`, a malformed or existing `vX.Y.Z`
   tag, a version that does not come after every existing one, a `sha` that is
   not on `main` after the last release, and one whose `.github/workflows` tree
   differs from `main`'s: `GITHUB_TOKEN` could not tag it, so release a newer
   commit. It also reports which named main CI jobs already passed on the
   commit (`checks`), without waiting for any;
2. reads the latest published release set and plans `<component>-vX.Y.Z` for the
   components whose `app/`, `web/` or `relay/` sources changed since their
   released source (`releases/autorelease.py`); unchanged ones keep their tags.
   It does not wait for main CI and writes no ref;
3. runs `release-set.yml` with the plan: every gate and build, then publication;
   `prepare` refuses a source that is not after the last release set;
4. `publish-set` creates `release-set-<sha>`, which is not a version tag, and
   attaches the completed manifest to it. It and the `tag` job hold a
   `contents: write` token, so they check out the workflow revision with full
   history and run its tooling, never an older selected commit's;
5. the `tag` job then creates the changed components' annotated tags at the
   source with their GitHub releases, and then the root `vX.Y.Z` tag with
   `release-tag`. Nothing else creates a version tag, and each step accepts what
   an earlier attempt created.

The `timeline` job's summary records the attempt, and from the dispatch the
manifest's publication with its readbacks and the final version tag.

No version tag exists until everything published. A release that fails before
`publish-set` leaves its version unused: fix the cause and dispatch the same
version again. A version that published anything (a Relay deployment, an npm
version, a TestFlight build) cannot publish other bytes, so a fix after that
ships as the next patch version. Publication authority is unchanged: the run is
a `workflow_dispatch` on `refs/heads/main` whose caller is
`production-cutover.yml@refs/heads/main`, which `release-set.yml`,
`publish.py authorize`, `ios-release-build.yml` and `recover.py` require.

If the `tag` job fails, everything has published: re-run that job. Every ref
the release writes (`release-set-<sha>`, the component tags, the root tag) uses
the workflow's `GITHUB_TOKEN`, so if a workflow file changed on `main` while the
release ran, GitHub may refuse it as it did for TAL-421. The step then fails and
prints the exact command that pushes that ref at the frozen commit; run it from a
clone, then re-run the failed jobs. Nothing retries it or uses another
credential, and an existing ref is reused only when it names the same commit.

The plan's request has this shape; `release-set.yml` dry runs take the same:

```json
{
  "sourceRevision": "<40-character main commit SHA>",
  "tags": {"app": "app-v1.10.1", "web": "web-v1.10.1", "relay": "relay-v0.2.0"},
  "relayDeploymentId": "<existing production deployment ID>"
}
```

`previous_release_set` is the last completed set's SHA. Preparation checks all
published root releases and rejects a missing or stale predecessor once a
release set exists.

The cutover runs every gate (selected-source and previous-App contracts,
the App's hosted unit tests on the release source when the App ships, reused
from main CI when its job already passed them there, pinned Agent compatibility, one
job per supported release, component builds), then deploys Relay, publishes Web,
the feedback bridge image and uploads the App at once, and publishes the manifest last. Nothing publishes
before `build-gate` has every gate and build. The ordering keeps only the
constraints that hold (TAL-414):

- Relay deploys before Web and the App publish. Preparation checks that the new
  Relay serves the previous Web and App, and the contract gates test the new
  Web and App against the new Relay's fixtures, but nothing tests them against
  the previous Relay, which serves them until the deployment succeeds.
- The feedback bridge image publishes after the Relay deployment it ships with,
  beside Web and the App; neither waits for it.
- Web and the App publish at once. The App was tested live against every
  supported Web, the latest completed Web releases included, and the Web
  against the previous App (`previousAppContracts`); neither needs the other
  published, and installations upgrade their Web on their own schedule anyway.
  The TestFlight upload, whose processing to `VALID` is the longest publication,
  therefore starts right after the Relay deployment.
- The manifest publishes after every selected publication read back
  (`check_results.py publication`): the Web updater reads only that manifest.
  The component releases and every version tag follow it in the `tag` job.

Publication is fail-closed rather than all-or-nothing: a failed Relay
deployment stops Web and the App before they publish, but Web and the App no
longer stop each other. Either can then be public without the manifest, and
both work with the released peers. **Re-run failed jobs** on the same run
retries the failed one, whose retry accepts the identical bytes already
published, and then `publish-set`. The App-only recovery workflow still covers
a failed App upload after Relay, the bridge image and Web succeeded.
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

Fresh dispatches require unused component release names. If only `publish-set`
or `tag` fails, use **Re-run failed jobs** on that same Actions run. It verifies
the original manifest fingerprint, notes and asset checksums before reusing
matching root and component releases and tags, finishing missing draft uploads. Conflicting
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
resumes the same IPA/upload using reviewed publishing tools, publishes the completed set, and
then creates the component tags and the root tag the original run did not reach. Release handoffs expire
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
