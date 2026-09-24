# Development

Run commands in this document from `app/`. Workflows live in `../.github/`.

This app is developed against a self-hosted `hermes-webui` server exposed over real HTTPS. See [`PROJECT_SPEC.md`](PROJECT_SPEC.md) for the full product and API plan.

> Sections covering TestFlight and App Store Connect are **maintainer-only ops** — they require the maintainer's Apple Developer account and App Store Connect access. Contributors never need them to build, test, or run the app.

## Primary Test Target

Use:

```text
https://<your-server>
```

Point this at your own `hermes-webui` server exposed through an HTTPS tunnel or reverse proxy (e.g. Cloudflare Tunnel). Real HTTPS works from both the iOS simulator and physical devices without an App Transport Security exception. If the server sets `HERMES_WEBUI_PASSWORD`, you need that password to sign in.

Before debugging the app, verify the server is reachable:

```zsh
curl https://<your-server>/health
```

## Visual References

Pixel references for core screens, shared states and the Live Activity families
live in `TalariaTests/VisualReferences`. See
[`docs/visual-references.md`](docs/visual-references.md) for how to read a diff
and how to re-record a reference on purpose.

## Server contract validation

The App uses the monorepo's `web/` component for current contract validation.
`UPSTREAM_REPOSITORY`, `UPSTREAM_BRANCH` and `UPSTREAM_TESTED_SHA` retain historical
standalone provenance.

From `app/`, run `scripts/validate-upstream-contract` for a disposable Web server,
live HTTP/SSE fixtures and focused Swift checks. Use `--ref <commit>` to test a
specific monorepo Web revision. [`CONTRACT_TESTS.md`](../CONTRACT_TESTS.md) maps
adopted behavior to each executable check.

## SSE and Cloudflare Stream Verification

Phase 4 streaming uses `GET /api/chat/stream?stream_id=...` over Server-Sent Events. Current upstream source confirms the stream response uses `Content-Type: text/event-stream; charset=utf-8`, `X-Accel-Buffering: no`, `Connection: keep-alive`, and sends `: heartbeat` comments every 30 seconds while no app event is ready.

Cloudflare can still close long-lived responses if the origin does not send data for long enough. The expected healthy behavior for Talaria is:

- streams longer than 2 minutes continue delivering tokens, tool events, reasoning events, title events, `done`, and `stream_end` when the server emits them;
- quiet periods under normal heartbeat behavior stay connected because the server writes `: heartbeat` about every 30 seconds;
- if the connection is cut while the upstream stream is still active, returning to the foreground or reconnecting should use `GET /api/chat/stream/status?stream_id=...` and reattach to the same stream instead of resending the user message.

Manual verification before closing Phase 4:

1. Sign in to `https://<your-server>` from the simulator.
2. Start a prompt that naturally runs for more than 2 minutes.
3. Keep the app foregrounded and verify streamed content continues past the 2 minute mark.
4. During another long response, background the app for at least 30 seconds, foreground it, and verify the app either reattaches to the active stream or reloads the completed transcript without duplicating the user message.
5. If a stream drops after a quiet gap, record whether the server emitted no tokens/tool/reasoning events for more than roughly 100 seconds. That is a known Cloudflare risk even with normal SSE support.

## Local-Only Fallback

For contributors without access to the tunnel, use this checkout's Web component:

```zsh
cd ../web
```

Follow the [Talaria Web setup guide](../web/README.md) for Docker or native Python
setup. The [release procedure](../releases/README.md) identifies compatible
component releases and the pinned Agent dependency. Repository-scoped GitHub
commands use `--repo MaudeCode/talaria`.

For simulator-only testing, `http://localhost:8787` can work when the server is running on the same Mac. For physical-device testing, use HTTPS or a Tailscale `100.64.0.0/10` IP; TestFlight builds include a scoped ATS exception for that Tailscale range.

## Example Server Setup (macOS + launchd)

One proven way to run the server natively on macOS is through launchd:

- LaunchAgent: `~/Library/LaunchAgents/com.hermes.webui.plist`
- Server script: `server.py` in the monorepo's `web/` directory
- Local bind: `127.0.0.1:8787`
- Public hostname: `https://<your-server>`
- Tunnel target: `http://127.0.0.1:8787`

Useful commands for this setup:

```zsh
launchctl load ~/Library/LaunchAgents/com.hermes.webui.plist
launchctl unload ~/Library/LaunchAgents/com.hermes.webui.plist
launchctl kickstart -k gui/$(id -u)/com.hermes.webui
cloudflared tunnel info <tunnel-name>
launchctl list | grep cloudflared
curl https://<your-server>/health
```

If the server appears down, check in this order:

1. launchd job status
2. local port `8787`
3. Cloudflare Tunnel status

For local port inspection:

```zsh
lsof -i :8787
```

## Local Validation With XcodeBuildMCP

XcodeBuildMCP is the preferred local validation path for feature and bug-fix slices. The repo config lives in `.xcodebuildmcp/config.yaml` and sets:

- Project: `Talaria.xcodeproj`
- Scheme: `Talaria`
- Configuration: `Debug`
- Simulator: configured in `.xcodebuildmcp/config.yaml`
- Bundle ID: `dev.kil.talaria`

After each completed implementation slice:

1. Confirm XcodeBuildMCP sees the repo defaults.
2. Run focused tests for the changed behavior when available.
3. Run the full XCTest suite before asking for review or committing.
4. Build and launch the app in Simulator when UI or runtime behavior changed.
5. Capture a screenshot or logs if the slice needs visual/runtime evidence.
6. Let the owner run the manual simulator checklist for the slice.

Agent/MCP flow:

- Call `session_show_defaults` before the first local build/run/test.
- If defaults are missing, copy them from `.xcodebuildmcp/config.yaml`.
- Run `scripts/setup-ios-test-pool` to fill the shared six-device iOS pool.
  It reuses the pool's runtime/model. `--refresh` replaces the whole pool only
  when every device is unleased and shut down. See the
  [shared pool guide](docs/ios-simulator-pool.md) for cross-project adoption.
- Use `scripts/test-ios [test-identifier ...]` for XCTest validation. It serializes
  XCTest across Talaria worktrees and leases from the cross-project pool, which
  erases each device on release. If the test host never connects ("The test
  runner hung before establishing connection") and no test case failed, the
  runner re-leases a device and retries exactly once; real failures never retry.
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

If the configured simulator is not installed, choose a nearby available iPhone simulator and update `.xcodebuildmcp/config.yaml` only if that should become the shared repo default.

## Local Script Environment

Configurable commands under `scripts/` load the optional repository-root `.env`
and then `.env.local`. Set `TALARIA_ENV_FILE` to load one additional file after
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
- `TALARIA_TEST_WORKER_COUNT` — parallel test workers for `scripts/test-ios` (default `4`, matching PR CI). Xcode clones the leased simulator per worker. Unfiltered runs also skip the measurement-only performance UI classes, as PR CI does; name a class to run it.
- `TALARIA_UPSTREAM_CONTRACT_RESPONSES` — test-only manifest supplied by `scripts/validate-upstream-contract`, not a persistent local setting.
- `TALARIA_DEVICE_ID` — physical iPhone selection for `scripts/run-ios-device`,
  as either the hardware UDID or the CoreDevice identifier from
  `xcrun devicectl list devices`.
- `TALARIA_DEVICE_DISCOVERY_ATTEMPTS` and `TALARIA_DEVICE_DISCOVERY_INTERVAL` —
  bounded retry budget for physical iPhone discovery.
- `TALARIA_SWIFT_FILE_SIZE_LIMIT` — warning threshold for `scripts/check-swift-file-sizes`.
- `HERMES_WEBUI_BASE_URL` and `HERMES_WEBUI_PASSWORD` — server credentials for `scripts/webui-json`.

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
needed for the new versions. Do not hand-edit the lockfile.

## Swift File-Size Policy

The repo keeps the project style target of small Swift files, but file-size enforcement is warning-only while the large code-audit refactors continue.

Run:

```zsh
scripts/check-swift-file-sizes
```

Policy:

- Warn on production app Swift files over 500 LOC.
- Exit successfully even when warnings are present.
- Scope the check to `Talaria/` production app files.
- Exempt tests, generated files, preview files, the share extension, and the live activity widget for now.
- Use warnings to make future drift visible; do not block current work on known oversized files.

You can override the warning threshold for local experiments:

```zsh
TALARIA_SWIFT_FILE_SIZE_LIMIT=300 scripts/check-swift-file-sizes
```

To keep that override local between shells, put
`TALARIA_SWIFT_FILE_SIZE_LIMIT=300` in `.env.local` instead.

## Raw xcodebuild Fallback

Use raw `xcodebuild` when XcodeBuildMCP is unavailable, when validating lower-level build failures, or when matching the GitHub Actions release/archive commands exactly. The TestFlight workflows continue to use raw `xcodebuild` and are not replaced by XcodeBuildMCP.

List available simulators:

```zsh
xcrun simctl list devices available
```

Build for an available iPhone simulator:

```zsh
xcodebuild -project Talaria.xcodeproj -scheme Talaria -destination 'platform=iOS Simulator,name=iPhone 15' build
```

If `iPhone 15` is not installed, choose a nearby available iPhone simulator.

## TestFlight Readiness Notes

Current status:

- App Store Connect app name: `Talaria`.
- Xcode target/scheme name: `Talaria`.
- iPhone home-screen display name: `Talaria`.
- Bundle ID: `dev.kil.talaria`.
- Test bundle ID: `dev.kil.talaria.tests`.
- App Store Connect distribution is active for `dev.kil.talaria`.
- Apple Developer Team ID: `Q28NF3NH3D`.
- Signing uses Xcode automatic signing.
- The app target carries Sign in with Apple and iCloud/CloudKit entitlements; the App ID and CloudKit schema steps are in [`docs/icloud-sync-setup.md`](docs/icloud-sync-setup.md).
- Export compliance is declared in `Info.plist` with `ITSAppUsesNonExemptEncryption = NO`; the app does not implement custom/proprietary encryption and uses normal Apple/platform networking security.
- App icon uses owner-supplied light and dark assets in `AppIcon.appiconset`.
- Launch screen uses the plist-based `UILaunchScreen` placeholder from `Info.plist`, which is acceptable for internal TestFlight validation.
- `PrivacyInfo.xcprivacy` is bundled with the app target. It declares no tracking, no developer-collected data, and app-only `UserDefaults` access for local preferences.
- Camera capture is deferred and is not declared. Add `NSCameraUsageDescription` and update the privacy review only if camera capture is implemented later.
- Signed `app-vX.Y.Z` tags validate App release identity; the authorized root release workflow publishes one external-capable TestFlight build. External tester assignment and Beta App Review sequencing are tracked in [`TESTFLIGHT.md`](TESTFLIGHT.md).

### Owner checklist: App Store Connect setup for Talaria

Keep the existing App Store Connect setup healthy:

1. Keep the `Talaria` app record for bundle ID `dev.kil.talaria` active.
2. Create `Talaria Branch` for `dev.kil.talaria.branch` only if side-by-side branch TestFlight builds are still useful.
3. Configure review metadata, privacy details, agreements, tax/banking, and tester groups as Apple requires.
4. Confirm each tagged upload appears under the expected Talaria record after processing.

### Branch TestFlight upload (CLI) — the "push to branch testflight" command

When the owner says **"push to branch testflight"**, upload the current *feature branch*
to the side-by-side **Talaria Branch** internal TestFlight app. This is a TestFlight
upload, **not** a Git push. Never merge, Git push, or upload the production
`dev.kil.talaria` TestFlight app unless the owner explicitly asks.

Branch TestFlight app identity:

- App Store Connect app name: `Talaria Branch`
- Main bundle ID: `dev.kil.talaria.branch`
- Share extension bundle ID: `dev.kil.talaria.branch.shareextension`
- Widget extension bundle ID (Live Activity + Provider quotas): `dev.kil.talaria.branch.liveactivitywidget`
- Display name: `Talaria Branch`
- App group: `group.dev.kil.talaria.branch`
- URL scheme: `talaria-branch`
- SKU: `talaria-ios-branch`

Steps:

1. Validate the branch first: at minimum `git diff --check` plus a simulator build; run
   focused or full tests based on the branch's risk.
2. Use a unique `CURRENT_PROJECT_VERSION` for every upload — prefer a timestamp-like
   number such as `YYYYMMDDHHMM`.
3. Archive with the reusable branch build config `Config/BranchTestFlight.xcconfig`:

   ```zsh
   xcodebuild -project Talaria.xcodeproj -scheme Talaria -configuration Release \
     -destination 'generic/platform=iOS' -archivePath build/TalariaBranch.xcarchive \
     -xcconfig Config/BranchTestFlight.xcconfig CURRENT_PROJECT_VERSION=<unique-build-number> \
     archive -allowProvisioningUpdates
   ```

4. Upload with the reusable export config `Config/BranchTestFlightExportOptions.plist`:

   ```zsh
   xcodebuild -exportArchive -archivePath build/TalariaBranch.xcarchive \
     -exportOptionsPlist Config/BranchTestFlightExportOptions.plist \
     -exportPath build/TalariaBranchExport -allowProvisioningUpdates
   ```

5. After upload succeeds, tell the owner the version/build number and that App Store
   Connect/TestFlight may need processing time before it appears on the phone.

### Production TestFlight releases

Production releases use the root [release-set workflow](../releases/README.md).
Signed `app-vX.Y.Z` tags validate release identity. Publication is a separate,
authorized `production-cutover.yml` dispatch from `main`, after a successful
root dry run. The request includes App, Web and Relay tags and the existing
Relay deployment ID; unchanged components reuse the previous completed set.

The `testflight` environment holds `APP_STORE_CONNECT_KEY_ID`,
`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY`,
`IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64` and
`IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`. Its branch policy must allow the trusted
`main` dispatch. The Apple Distribution identity belongs to team `Q28NF3NH3D`.

The App tag supplies the marketing version. App Store Connect selects the next
collision-free build number. The signed build includes the app, share extension
and Live Activity widget. Publication verifies the IPA identity and checksum,
uploads it, and waits for processing before recording success. One
external-capable build serves both internal and external testing.

After processing, add the build to the internal group and validate it on the
owner's iPhone. External group assignment and Beta App Review remain manual
App Store Connect choices. A root dry run builds an unsigned archive; it does
not upload or produce an installable phone build.

## Full-App Manual Regression Checklist

Use this before internal TestFlight smoke builds and again before adding external testers.
Capture bugs, polish notes, and follow-up ideas in [GitHub Issues](https://github.com/MaudeCode/talaria/issues).

### Onboarding/Auth
- Fresh install opens onboarding.
- Valid server URL + password logs in.
- A compatible OIDC-only server offers Continue with SSO and returns to the app with a server/state/PKCE-bound session.
- Wrong password shows clear error.
- Server/tunnel down shows useful error.
- Sign out and reconfigure returns to onboarding.

### Sessions
- Load sessions online.
- Pull to refresh.
- Search sessions.
- Create new session.
- Pin/unpin.
- Archive/restore.
- Move to project and back to no project.
- Duplicate/fork.
- Delete disposable session only.
- Offline cached session list displays clearly.

### Chat/Streaming
- Open existing session at latest message.
- Send normal message.
- Watch response stream.
- Stop response.
- Send while streaming using each configured behavior.
- Background/foreground during active stream.
- Long response over 2 minutes.
- Network interruption recovery.
- Offline cached transcript is read-only.

### Message Actions
- User message: edit, fork, copy.
- Assistant message: listen, stop listening, select text, regenerate, fork, copy.
- Older edit/regenerate shows discard warning.
- Local assistant command cards do not expose destructive message actions.

### Composer
- Model picker and favorites/recents.
- Reasoning picker.
- Workspace picker.
- Profile switch, including new-session confirmation.
- Attach file.
- Attach one photo.
- Attach multiple photos.
- Paste image/file.
- Failed upload preserves draft.
- Voice input allowed, denied, stopped, and sent.
- Haptics on send/response completion on device.

### Slash Commands
- `/help`
- `/new`
- `/model`
- `/workspace`
- `/reasoning`
- `/title`
- `/personality`
- `/skills`
- Direct skill slash shortcut.
- `/queue`
- `/steer`
- `/interrupt`
- `/status`
- `/btw`
- `/background` and `/bg`
- `/branch` and `/fork`
- `/undo`
- `/retry`
- `/compress` and `/compact`
- Unsupported commands show friendly local message.

### Server Panels
- Files list/search.
- Text file preview.
- Image preview.
- Unsupported binary preview.
- Tasks list/detail/output.
- Skills list/search/detail/linked file.
- Memory notes/profile.
- Usage analytics timeframe switching.

### Polish/Launch
- Light and dark mode.
- Portrait and landscape.
- Largest Dynamic Type.
- VoiceOver core path.
- App icon visible.
- Launch screen acceptable.
- Privacy permission prompts readable.
- TestFlight install path documented.

Preferred Git workflow before CI automation:

1. Create one `<type>/TAL-<number>-<slug>` branch per work item.
2. Build and test on that branch.
3. Merge to `main` only after validation passes.
4. Treat `main` as the source for internal TestFlight candidates.
