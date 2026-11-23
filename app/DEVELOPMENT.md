# Development

Run commands in this document from `app/`. Workflows live in `../.github/`.
Release and TestFlight operations are in [`TESTFLIGHT.md`](TESTFLIGHT.md).

The scripts under `scripts/` and `ci/` run with `#!/usr/bin/env bash` and need bash 5; macOS ships 3.2, so
install Homebrew's (`brew install bash`) and keep it first on `PATH`. CI does the same through
`.github/actions/setup-bash`.

`scripts/test-ios` builds once and launches the generated `.xctestrun`, as hosted CI does. The test phase retains its runner-connection guard without reopening the project or resolving its workspace again. A missing or ambiguous build receipt stops before test launch.

## Server

Develop against a [Talaria Web](../web/README.md) server. Your own server behind
real HTTPS (for example Cloudflare Tunnel) works from the simulator and physical
devices with no App Transport Security exception. Check it before debugging the
app:

```zsh
curl https://<your-server>/health
```

To run this checkout's server instead, follow the
[Talaria Web setup](../web/README.md) from `../web`. To keep it running at login
under launchd or systemd, see [running under a supervisor](../web/docs/supervisor.md).
The simulator can use `http://localhost:8787` when the server runs on the same
Mac. Physical devices need HTTPS or a Tailscale `100.64.0.0/10` address, which
the app's ATS exception allows over HTTP.

## Server contract validation

App requests, decoding and streaming are validated against this monorepo's
`web/`. Run `scripts/validate-upstream-contract` for a disposable Web server,
live HTTP/SSE fixtures and focused Swift checks; `--ref <commit>` tests a
specific monorepo revision. [`CONTRACT_TESTS.md`](../CONTRACT_TESTS.md) maps each
contract to its check, and [SSE streams](../web/docs/sse-streams.md) describes the
stream endpoints and resume behavior.

Long streams through Cloudflare can drop after a long quiet gap even with SSE
heartbeats. When changing stream recovery, check by hand that a run longer than
two minutes keeps streaming, and that backgrounding the app mid-run and
returning reattaches to the stream or reloads the finished transcript without
resending the message.

## Visual References

Pixel references for core screens, shared states and the Live Activity families
live in `TalariaTests/VisualReferences`. See
[`docs/visual-references.md`](docs/visual-references.md) for how to read a diff
and how to re-record a reference on purpose.

## TalariaKit package

`TalariaKit/` is a local Swift package with the App logic that needs no app host:
models, networking (API client, SSE, contract types), persistence and sync, and
the view models and presentation logic behind every screen (chat, sessions,
Kanban, settings, workspace, auth). The App, the share extension and the Live
Activity widget link it. Its tests run on macOS without a simulator; CI runs
them on every App change, beside the App build for testing. The
simulator-hosted `TalariaTests` run in full on `main` pushes, at release and on
pull requests labelled `hosted-tests`. A pull request runs only the tests its
diff reaches ([Run the tests a change affects](#run-the-tests-a-change-affects)),
hosted ones included without the label, and repeats each test method it adds or
changes for up to 50 attempts within 90 s (hosted) or 60 s (TalariaKit), so a
flaky test fails the pull request that wrote it (TAL-2402):

```zsh
swift test --package-path TalariaKit
swift test --package-path TalariaKit --filter SSEClientTests
```

Code that needs UIKit, ActivityKit, App Intents metadata, the app host, Keychain
entitlements or app resources stays in the App targets, and so do its tests in
`TalariaTests`. App Intents types (`AppEnum`, `AppEntity`, widget configuration
intents) stay in the App or widget: their metadata names the module, so moving
one changes saved widget and shortcut configurations. When package code needs a
platform API, it calls a hook in `TalariaKit/Sources/TalariaKit/Platform/`
(`PlatformHooks`, `HapticEmitter.perform`), which `Talaria/PlatformBridges.swift`
installs at launch; under `swift test` the hooks keep their inert defaults. The
App sees only `public` TalariaKit declarations; add `public` only where App code
needs it. `TalariaTests` also compiles
`TalariaKit/Tests/TalariaKitTests/Support/`, so both test targets share the API
test doubles. Strings that TalariaKit localizes resolve in the host bundle, so
add new ones to the App's `Localizable.xcstrings` by hand: Xcode does not extract
package strings into it.

### Package test coverage

CI measures coverage on the same `swift test` run it gates on and reports it in
the job summary: line and function coverage of
`TalariaKit/Sources` in total and per top-level directory. Package checkouts,
generated resource accessors and the tests themselves are excluded. The
`app-package-coverage` artifact keeps `coverage.txt`, the per-file table, and `coverage.json`, the
per-line `llvm-cov export`; it is uploaded after failed runs too and kept for 14
days. Simulator-hosted App target code (`Talaria/`, the extensions) runs in the
hosted unit tests shard and is not in the number.

The baseline when coverage landed was 82.37% of lines (33,497 of 40,667) and
76.86% of functions (5,056 of 6,578) across 225 files. Read it as visibility:
nothing gates on a percentage, so compare a PR's summary with `main`'s and look
at the directory table or `coverage.txt` for code a change added without tests.
Function coverage counts closures, so it trails line coverage. Local runs stay
uninstrumented; to reproduce the report:

```zsh
swift test --package-path TalariaKit --enable-code-coverage
ci/package-coverage
```

## Local Validation With XcodeBuildMCP

XcodeBuildMCP is the preferred local validation path for feature and bug-fix slices. The config lives at the repository root in `../.xcodebuildmcp/config.yaml` and sets:

- Project: `Talaria.xcodeproj`
- Scheme: `Talaria`
- Configuration: `Debug`
- Simulator: configured in `../.xcodebuildmcp/config.yaml`
- Bundle ID: `dev.kil.talaria`

After each completed implementation slice:

1. Confirm XcodeBuildMCP sees the repo defaults.
2. Run the tests that `$talaria-ios-testing` selects for the change.
3. Build and launch the app in Simulator when UI or runtime behavior changed.
4. Capture a screenshot or logs if the slice needs visual/runtime evidence.

Agent/MCP flow:

- Call `session_show_defaults` before the first local build/run/test.
- If defaults are missing, copy them from `../.xcodebuildmcp/config.yaml`.
- Run `scripts/setup-ios-test-pool` to fill the shared six-device iOS pool.
  It reuses the pool's runtime/model. `--refresh` replaces the whole pool only
  when every device is unleased and shut down. See the
  [shared pool guide](docs/ios-simulator-pool.md) for cross-project adoption.
- Use `scripts/test-ios [test-identifier ...]` for XCTest validation; with no
  identifier it runs `TalariaTests`. It serializes
  XCTest within one worktree; worktrees run concurrently, each on its own lease
  from the cross-project pool, which erases each device on release. If the test host has not connected within
  `TALARIA_RUNNER_CONNECT_TIMEOUT` seconds (default 30), the runner reboots the simulator and launches once more,
  then stops the run naming the simulator; test failures never retry.
  Connection is confirmed by Xcode's test-host readiness/capabilities or execution acknowledgement in the current
  result bundle's session log, or the first suite event. Execution-worker preparation and bundle warm-up can precede
  that suite; the existing warm-up bound and final test result are retained after connection.
  Prefix `TALARIA_TEST_SCREENSHOTS=1` to keep each hosted test's evidence screenshots in its result bundle; other
  runs render only a failing test's window.
  Tests run in process under the isolated `.xctest` app and app-group identity,
  with in-memory authentication, draft, and cache state; they do not read
  simulator login state or contact an external server. See
  [performance budgets](docs/performance-budgets.md) for what is measured, the
  baselines behind each threshold, and how to compare a run. Flows that need the
  system to deliver a gesture, sheet or launch are checked on a phone:
  [phone checks](docs/phone-checks.md).
- When a simulator stops responding, run `scripts/ios-simulator-doctor <udid>` (default `$IOS_SIMULATOR_ID`) before
  touching it. It is read-only and bounds every probe (`IOS_SIMULATOR_DOCTOR_TIMEOUT`, default 20 s), then prints
  the device's pool lease owner and one verdict with the next step: `SERVICE_UNRESPONSIVE` (CoreSimulator itself is
  stuck; restarting it stops every booted simulator, so only the Mac owner decides), `DEVICE_UNRESPONSIVE`,
  `MEMORY_PRESSURE` (the device stopped answering while the Mac pages; heavy swap alone is only a warning),
  `ZOMBIE_APP` (a killed or detached debugger left Talaria a zombie), `NOT_BOOTED`, `UNKNOWN_DEVICE` or `HEALTHY`.
  A device under a live lease is released by stopping that run, never by shutting it down underneath it. Exit 0
  means nothing is stuck.
- `scripts/test-history-drag --simulator-id ID --agent-device PATH --config PATH --session SESSION`
  drives the hosted history regression with a real native drag. Use an idle pool
  simulator and the driver arguments supplied by T3's Device panel. The harness
  uses `test-ios` for the lease/build and records frame/reader assertions and
  screenshots under `.codex-tmp/xctest/history-drag/`. Add `--large-history` to
  start with 1,000 loaded messages, or `--fling` to check native momentum after
  touch-up. The fling uses `swipe`; the driver's `scroll` deliberately brakes
  before release. All three external-driver cases explicitly skip
  in ordinary hosted runs; phone validation remains required.
- Use `scripts/run-ios` for manual worktree testing. It leases one pool simulator,
  builds the isolated `.xctest` app, launches the deterministic fixture, and opens
  Simulator. Keep the command running for the manual session, then press Control-C
  to shut down the simulator and release its lease.
- In T3 Code, follow the [Device panel workflow](../.agents/skills/talaria-ios-testing/SKILL.md#t3-code-device-panel).
  `scripts/run-ios --no-open` keeps the same build, lease and fixture launch
  without opening the desktop simulator window. `scripts/run-ios --prepare-only`
  also skips the launch, so the Device panel's command launches the fixture with
  its own arguments.
- Use `screenshot`, UI inspection, and log capture only when they help validate the slice.

Human/CLI equivalents:

```zsh
xcodebuildmcp simulator list --enabled
```

```zsh
scripts/test-ios TalariaTests/ExampleTests/testExample
scripts/test-ios
```

### Run the tests a change affects

`scripts/test-ios --changed` runs the App tests this checkout's changes reach:
committed, staged, unstaged and untracked, against the merge-base with
`origin/main` (`--base REF` for another). It is the plan pull request CI makes
for the same diff (`scripts/changed-components.py --app-plan`). Each target,
TalariaKit's package tests and the simulator-hosted `TalariaTests`, comes out
full, as explicit `Target/Class` or `Target/Class/testMethod` identifiers, or
empty, with the reasons:

- A change inside one test method runs that method; a change elsewhere in a test
  class (setup, helpers, properties) runs the class and its subclasses.
- A change in test support runs every test that reaches the changed declaration,
  through other helpers too; the reasons name the helpers it went through.
- Production code narrows only through a reviewed rule in
  `ci/test-ownership.json`. Anything else runs the affected target in full: App,
  extension, project and resource changes the hosted target; TalariaKit sources,
  the package manifest and shared CI both. Comments and whitespace run nothing.

`--dry-run` prints the plan and the hosted shard layout CI would use without
running anything. Locally the hosted lane runs on one simulator lease. For full
proof, run `scripts/test-ios` and `scripts/test-package`; for a branch on CI,
`gh workflow run ci.yml --ref <branch>` runs every suite in full. Main pushes and
releases always run both targets in full.

### Native iPhone Duo tests in CI

CI's iPhone 17 runs an older runtime and has no vertical bar, so hosted tests
that read the vertical bar (`verticalBarEdge`), or skip below the Duo's iOS 27.1
runtime through a `#available(iOS 27.1, *)` guard, skip there (TAL-1456). When a
hosted lane selects any of them, `ci/hosted-test-shard` plans one more shard,
**App native Duo tests**: only those tests, on an iPhone Duo at the newest
runtime the SDK runs that supports it (`setup-xcode`'s `IOS_SIMULATOR_DUO_OS`).
`scripts/select-ios-simulator` finds or creates the Duo, which starts closed under
`xcodebuild test`. A full hosted run, as on the daily full run, a labelled pull
request or a release, runs every native Duo test there; an explicit lane runs the
native Duo tests among its identifiers; a lane with none, a repeat-only run and
a diagnostic's repeated attempts add no Duo shard. `--dry-run` shows the shard.

- The shard takes a macOS slot beside the build, as the repeat shard does, so a
  full lane plans at most three iPhone 17 shards.
- `DUO_KNOWN_FAILURES` in `scripts/app_test_plan.py` names each test that fails
  on the native Duo with the ticket that owns it. The shard leaves those out
  with `-skip-testing` and its summary lists them; nothing skips or loosens them
  in the test. The owning fix deletes its entries, and a stale entry fails the
  plan.
- Its summary names the device, runtime and each case's outcome on the Duo,
  apart from the iPhone 17 shards' skips, and the gate checks that every planned
  identifier ran there exactly once, apart from the lane's own proof.
- A runner image with no compatible Duo skips the shard: its summary and the
  gate say why, and CI Gate passes. A Duo shard that ran and failed fails the
  App suite and CI Gate.
- It shares the shard test step's limits: one minute per test, the runner-connect
  stall check, and the step's 40 minutes, which sits above the slowest measured
  shard (14 minutes of testing) with the settle wait and one launch recovery. The full native Duo selection took
  195 s of testing on a local iPhone Duo at iOS 27.1: 36 cases, 30 passed,
  3 skipped, and only the 3 known TAL-2563 failures failed.

### Repeat one test

To investigate a flaky test, repeat it alone with the identifier a failure
names:

```zsh
scripts/test-ios --repeat 20 TalariaTests/SessionListHostedTests/testDeepLinkedChatKeepsNavigationStackAndToolbarMountedOnPhone
scripts/test-ios --repeat 20 TalariaKitTests/SharedContractTests/testToolsetCatalogDecodesServerPolicy
scripts/test-ios --remote --sha "$(git rev-parse HEAD)" --repeat 20 TalariaTests/SessionListHostedTests/testDeepLinkedChatKeepsNavigationStackAndToolbarMountedOnPhone
```

Hosted identifiers build once and run on one simulator with
`-test-iterations N -run-tests-until-failure`; `TalariaKitTests` identifiers run
through `scripts/test-package`, which builds once and repeats `swift test
--skip-build`. Both stop at the first failing attempt and report the completed
attempts, the failing one and where its result bundle or log is. `--remote`
dispatches the same run to the `App test diagnostics` workflow on a hosted runner
at a pushed commit and prints its run and tested commit. It runs beside the pull
request's CI: it never cancels it, posts statuses only under its own run's name,
and never counts as CI or release evidence. Repetitions are 1 to 100; a typo, an
unknown commit or an invalid count fails before anything builds.

```zsh
scripts/run-ios
```

If the configured simulator is not installed, choose a nearby available iPhone simulator and update `../.xcodebuildmcp/config.yaml` only if that should become the shared repo default.

### Record a screen transition

A settled screenshot can miss a flash between two screens. In T3 Code, record the
transition through the Device panel against the leased fixture build:

1. Run `scripts/run-ios --prepare-only` in a persistent terminal. It leases a pool
   simulator, builds the isolated `.xctest` app, verifies its signature and bundle
   ID, installs it and prints `Simulator ID:` and `Fixture bundle ID:`. It holds
   the lease without opening Simulator or launching the app.
2. Call `device_list`, then `device_open` with that simulator ID and its host.
   `AD` below is the exact command path `device_open` returns; it is already bound
   to the device and session.
3. Launch, record and build the contact sheet. The second fixture argument is an
   optional scenario; the relaunch is the cold route, or drive the in-app
   transition instead:

   ```sh
   "$AD" open dev.kil.talaria.xctest --launch-args=--ui-test-fixture --launch-args=--ui-test-long-bodies
   "$AD" record start --scope device /tmp/transition.mp4
   "$AD" open dev.kil.talaria.xctest --relaunch --launch-args=--ui-test-fixture --launch-args=--ui-test-long-bodies
   "$AD" record stop
   "$AD" record contact-sheet /tmp/transition.mp4 --out /tmp/transition-sheet.png
   ```

4. Read every cell of the sheet. The command prints `N cells over Ts (S sample
   times, F frames decoded)`: a flash shorter than the gap between sample times is
   not in the sheet, and fewer decoded frames than sample times leaves holes, so
   scrub the movie around a suspect change.
5. Run `"$AD" close` without `--shutdown`, call `device_close` with
   `shutdown=false`, then press Control-C in the runner. Confirm the simulator is
   `Shutdown` and its lease file is gone ([pool guide](docs/ios-simulator-pool.md)).

Judge the frames against the case's pass criterion in
[Transitions](../docs/design-system.md#17-transitions-app). Attach the sheet
and movie to the PR; never commit them.

## Display-phase signposts

The app marks the waits users feel as `os_signpost` intervals in every build
(`TalariaKit/Sources/TalariaKit/Config/DisplayPhaseTrace.swift`). In Instruments'
os_signpost instrument, or `log show --signpost`, filter by the app's bundle
identifier and category `Performance`:

- `Launch` and `Launch Ready`: from app start to the first root (the restored
  chat's first transcript, cached rows or empty state, or the New Chat
  composer), and to its first server-backed frame. A launch into onboarding
  ends both as `outcome=onboarding`.
- `Session Open` and `Session Open Ready`: from a session-list open to the
  chat's first transcript frame, and to its server transcript.
- `Load Earlier`: from an older-history request to the prepended rows' layout.

Each interval ends once with `outcome=<cache|server|composer|retained|failed|…>
rows=<count>`; replaced, failed or abandoned operations end as not reached.
No session ID, title, path or text is recorded.

`scripts/benchmark-display-phases A.app B.app` compares fixture builds on a
leased pool simulator, alternating cold launches that open the fixture session
through the deep-link route, and reports each interval's median, range and
misses. Build each with
`scripts/run-ios` and copy its `Talaria.app` aside before building the next.

## Local Script Environment

Configurable commands under `scripts/` load the optional `app/.env` and then
`app/.env.local`. Set `TALARIA_ENV_FILE` to load one additional file after
those defaults; a relative path is resolved from the command's working directory.
An explicitly requested file must exist.

Precedence is: exported process environment, `TALARIA_ENV_FILE`, `.env.local`,
`.env`, then each script's built-in default. This keeps values supplied by CI or
the invoking shell authoritative. `scripts/webui-json` also accepts
`TALARIA_WEB_ENV_FILE` as a compatibility alias when `TALARIA_ENV_FILE` is not
set.

Environment files support blank lines, comments, `KEY=value`,
`export KEY=value`, CRLF line endings, and single- or double-quoted values. They
are parsed as data and never executed as shell commands. The repository ignores
local environment files; do not commit credentials.

The portable `scripts/setup-ios-test-pool` reads exported environment variables
only. To apply Talaria's local files to setup, run
`scripts/load-env scripts/setup-ios-test-pool`.

Recognized variables:

- `IOS_SIMULATOR_POOL_SIZE` — simulator count for `scripts/setup-ios-test-pool`.
- `IOS_SIMULATOR_ID` — shared simulator selection, with `TALARIA_SIMULATOR_ID` as an alias for `scripts/test-ios`.
- `TALARIA_RUNNER_CONNECT_TIMEOUT` — seconds `scripts/test-ios` waits for the test host to connect before rebooting the simulator for its one relaunch (default 30). A runner that fails to launch before any test ran gets the same relaunch, and a second fault stops the run with status 70 (`scripts/xctest-launch`, shared with the hosted CI tests).
- `TALARIA_LIVE_CONTRACT_RESPONSES` — path to a live-response manifest for the TalariaKit live decoding test, supplied by `scripts/validate-upstream-contract` and CI, not a persistent local setting.
- `TALARIA_DEVICE_ID` — physical iPhone selection for `scripts/run-ios-device`,
  as either the hardware UDID or the CoreDevice identifier from
  `xcrun devicectl list devices`.
- `TALARIA_DEVICE_DISCOVERY_ATTEMPTS` and `TALARIA_DEVICE_DISCOVERY_INTERVAL` —
  bounded retry budget for physical iPhone discovery.
- `TALARIA_SWIFT_FILE_SIZE_LIMIT` — warning threshold for `scripts/check-swift-file-sizes`.
- `TALARIA_WEB_BASE_URL` and `TALARIA_WEB_PASSWORD` — server credentials for `scripts/webui-json`.

## Talaria Dev

Development builds for the maintainer's iPhone use the side-by-side Talaria Dev
identity in `Config/Dev.xcconfig`: bundle ID `dev.kil.talaria.branch` (plus its
`.shareextension` and `.liveactivitywidget`), App Group and iCloud container
`*.dev.kil.talaria.branch`, URL scheme `talaria-branch`, display name
`Talaria Dev` and the DEV-banner icon `Talaria/Resources/TalariaDev.icon`. It
has its own data and server setup, so it never replaces the App Store or
TestFlight app.

- `scripts/run-ios-device` installs a Debug Talaria Dev build over USB or local
  Wi-Fi and refuses any other bundle ID.

## Signing with your own Apple team

The committed signing identity (`DEVELOPMENT_TEAM`, bundle IDs) belongs to the
maintainer. Never edit `Config/Shared.xcconfig` or `project.pbxproj` to sign
with your own team; override locally instead:

1. Create `Config/Local.xcconfig`. It is gitignored.

   ```xcconfig
   DEVELOPMENT_TEAM = YOUR_TEAM_ID
   // Optional — only needed if provisioning complains about the bundle ID.
   // The app-group entitlement must stay in sync with the bundle ID.
   // APP_BUNDLE_IDENTIFIER = com.yourname.talaria
   // APP_GROUP_IDENTIFIER = group.com.yourname.talaria
   // ICLOUD_CONTAINER_IDENTIFIER = iCloud.com.yourname.talaria
   ```

2. Build normally. `Config/Shared.xcconfig` ends with `#include? "Local.xcconfig"`,
   so your values override the committed defaults for every target.

Simulator builds don't need a paid team. CI signs simulator builds ad hoc
(`CODE_SIGN_IDENTITY=-`), which needs no certificate but still embeds
entitlements. A build made with `CODE_SIGNING_ALLOWED=NO` has no entitlements,
so Keychain and the share extension's app group break when you install it for
manual testing; use a normally signed build for that.

## Swift package updates

Normal CI, test, and release builds use the versions in
`Talaria.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
Update packages only in a dedicated change. Choose the new versions with
Xcode's package dependency editor or **File > Packages > Update to Latest
Package Versions**, then refresh and test the lockfile:

```zsh
xcodebuild -resolvePackageDependencies -project Talaria.xcodeproj -scheme Talaria
scripts/test-ios
```

Review and commit the resulting `Package.resolved` diff with the code changes
needed for the new versions. Do not hand-edit the lockfile. For a package that
TalariaKit also uses, run `swift package update --package-path TalariaKit` too, so
`TalariaKit/Package.resolved` pins the same revisions; the tooling tests
compare the two.

## Swift File-Size Policy

The project targets small Swift files. The check only warns.

Run:

```zsh
scripts/check-swift-file-sizes
```

Policy:

- Warn on production app Swift files over 500 LOC.
- Exit successfully even when warnings are present.
- Scope the check to `Talaria/` production app files.
- Exempt tests, generated files, preview files, the share extension, and the Live Activity widget.

You can override the warning threshold for local experiments:

```zsh
TALARIA_SWIFT_FILE_SIZE_LIMIT=300 scripts/check-swift-file-sizes
```

To keep that override local between shells, put
`TALARIA_SWIFT_FILE_SIZE_LIMIT=300` in `.env.local` instead.

## Raw xcodebuild Fallback

Use raw `xcodebuild` when XcodeBuildMCP is unavailable or when validating lower-level build failures.

List available simulators:

```zsh
xcrun simctl list devices available
```

Build for the simulator:

```zsh
xcodebuild -project Talaria.xcodeproj -scheme Talaria -destination 'generic/platform=iOS Simulator' build
```
