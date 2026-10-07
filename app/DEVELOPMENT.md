# Development

Run commands in this document from `app/`. Workflows live in `../.github/`.
Release and TestFlight operations are in [`TESTFLIGHT.md`](TESTFLIGHT.md).

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
them on every App change, beside the App build for testing, while the
simulator-hosted `TalariaTests`, the launch smoke test and the UI suite run
nightly and as a release gate:

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
the package tests job summary: line and function coverage of
`TalariaKit/Sources` in total and per top-level directory. Package checkouts,
generated resource accessors and the tests themselves are excluded. The
`app-package-coverage` artifact (`ui-suite-package-coverage` from the full
suite) keeps `coverage.txt`, the per-file table, and `coverage.json`, the
per-line `llvm-cov export`; it is uploaded after failed runs too and kept for 14
days. Simulator-hosted App target code (`Talaria/`, the extensions) runs only
in the full suite and is not in the number.

The baseline when coverage landed was 82.37% of lines (33,497 of 40,667) and
76.86% of functions (5,056 of 6,578) across 225 files. Read it as visibility:
nothing gates on a percentage, so compare a PR's summary with `main`'s and look
at the directory table or `coverage.txt` for code a change added without tests.
Function coverage counts closures, so it trails line coverage. Local runs stay
uninstrumented; to reproduce the report:

```zsh
swift test --package-path TalariaKit --enable-code-coverage --skip UntrustedInputFuzzSoakTests
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
- Use `scripts/test-ios [test-identifier ...]` for XCTest validation. It serializes
  XCTest within one worktree; worktrees run concurrently, each on its own lease
  from the cross-project pool, which erases each device on release. If the test host never connects ("The test
  runner hung before establishing connection") and no test case failed, the
  runner re-leases a device and retries that pass exactly once; real failures never retry.
  XCUI launches a DEBUG-only local fixture under the isolated `.xctest` app and app-group identity,
  with in-memory authentication, draft, and cache state. It does not read simulator
  login state or contact an external server. A skipped functional `TalariaUITests`
  test fails the run. Performance-only UI measurements run on `main` CI instead
  of every pull request; they remain part of the full local suite. See
  [performance budgets](docs/performance-budgets.md) for what is measured, the
  baselines behind each threshold, and how to compare a run.
- Use `scripts/run-ios` for manual worktree testing. It leases one pool simulator,
  builds the isolated `.xctest` app, launches the deterministic fixture, and opens
  Simulator. Keep the command running for the manual session, then press Control-C
  to shut down the simulator and release its lease.
- Use `screenshot`, UI inspection, and log capture only when they help validate the slice.

Human/CLI equivalents:

```zsh
xcodebuildmcp simulator list --enabled
```

```zsh
scripts/test-ios TalariaTests/ExampleTests/testExample
scripts/test-ios
```

```zsh
scripts/run-ios
```

If the configured simulator is not installed, choose a nearby available iPhone simulator and update `../.xcodebuildmcp/config.yaml` only if that should become the shared repo default.

## Local Script Environment

Configurable commands under `scripts/` load the optional `app/.env` and then
`app/.env.local`. Set `TALARIA_ENV_FILE` to load one additional file after
those defaults; a relative path is resolved from the command's working directory.
An explicitly requested file must exist.

Precedence is: exported process environment, `TALARIA_ENV_FILE`, `.env.local`,
`.env`, then each script's built-in default. This keeps values supplied by CI or
the invoking shell authoritative. `scripts/webui-json` also accepts
`HERMES_WEBUI_ENV_FILE` as a compatibility alias when `TALARIA_ENV_FILE` is not
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
- `TALARIA_TEST_WORKER_COUNT` — parallel UI test workers for `scripts/test-ios` (default `4`; CI instead splits the suite across simulators with `ci/test_shards.py`, one worker each). Xcode clones the leased simulator per worker. `TalariaTests` runs first in its own pass on the leased device without clones: a clone that launches the unit-test host while Xcode installs the UI runner there loses the runner. Unfiltered runs also skip the measurement-only performance UI classes, as CI does; name a class to run it. Classes that need an iPad or a Pro Max (`DEVICE_CLASSES` in `ci/test_shards.py`) never run on the leased iPhone, where they would skip: they run last, each on an available local simulator whose name matches (`iPad …`, `… Pro Max`), and CI's catch-all shard runs them on the hosted image's matching simulator.
- `TALARIA_LIVE_CONTRACT_RESPONSES` — path to a live-response manifest for the TalariaKit live decoding test, supplied by `scripts/validate-upstream-contract` and CI, not a persistent local setting.
- `TALARIA_DEVICE_ID` — physical iPhone selection for `scripts/run-ios-device`,
  as either the hardware UDID or the CoreDevice identifier from
  `xcrun devicectl list devices`.
- `TALARIA_DEVICE_DISCOVERY_ATTEMPTS` and `TALARIA_DEVICE_DISCOVERY_INTERVAL` —
  bounded retry budget for physical iPhone discovery.
- `TALARIA_SWIFT_FILE_SIZE_LIMIT` — warning threshold for `scripts/check-swift-file-sizes`.
- `HERMES_WEBUI_BASE_URL` and `HERMES_WEBUI_PASSWORD` — server credentials for `scripts/webui-json`.

## Talaria Dev

Development builds for the maintainer's iPhone use the side-by-side Talaria Dev
identity in `Config/Dev.xcconfig`: bundle ID `dev.kil.talaria.branch` (plus its
`.shareextension` and `.liveactivitywidget`), App Group and iCloud container
`*.dev.kil.talaria.branch`, URL scheme `talaria-branch`, display name
`Talaria Dev` and the DEV-banner icon `Talaria/Resources/TalariaDev.icon`. It
has its own data and server setup, so it never replaces the App Store or
TestFlight app.

- `scripts/publish-devapps --ticket TAL-<n> --ticket-title <title> --title <build title> --notes <notes>`
  archives Talaria Dev, exports a `release-testing` IPA and publishes it to
  <https://devapps.thezoo.house/apps/talaria-dev/>. This is the normal way to
  deliver a build to the phone.
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
