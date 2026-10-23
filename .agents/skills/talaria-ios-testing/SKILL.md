---
name: talaria-ios-testing
description: Run Talaria XCTest and simulator validation, including iPhone Duo posture and panel screenshots, for compiled App changes, explicit test requests, and simulator runtime checks. Use targeted tooling checks for CI scripts, documentation, and release-note edits.
---

Run app commands from `app/`; unqualified source and tooling paths are relative
to `app/`. GitHub workflows and shared contract documentation remain at the root.

# Talaria iOS testing

Use terminal validation. Prefer XcodeBuildMCP when it is available; otherwise use
`xcodebuild` and `xcrun simctl`.

## Validation scope

Use XCTest for compiled App sources, test targets, bundled resources, entitlements,
and Xcode configuration. For CI, helper scripts, docs, skills, and changelog-only
changes, run their focused tooling/schema checks instead. Root
`scripts/changed-components.py` records CI routing; inspect the actual diff rather
than selecting tests from a ticket's `app` label. Shared HTTP/SSE changes also
use the contract skill.

## XCTest

App logic that needs no app host lives in the `TalariaKit` package; its tests
run on macOS without a simulator: `swift test --package-path TalariaKit
[--filter <Class>]`. Run them for any `TalariaKit/` change; they take seconds.

Run simulator-hosted XCTest only through `scripts/test-ios [test-identifier ...]`.

1. Run the smallest focused test identifier that covers the change.
2. Wait for it to finish.
3. For App changes, run `swift test --package-path TalariaKit` and `scripts/test-ios TalariaTests` before review or commit. HTTP/SSE changes also require the contract checks. For UI changes, also run the flows they touch from [phone checks](../../../app/docs/phone-checks.md) on a DevApps build.

CI (pull requests and main pushes) runs, for every App change, `swift test` for
TalariaKit, the App build for testing (App, extensions and the test bundle) and
the simulator-hosted unit tests (`TalariaTests`) in one shard; releases run the
same hosted unit tests.

The script serializes runs within one worktree and leases pooled simulators across
worktrees. Let the current run finish instead of starting an overlapping run.

## Simulator validation

- For iPhone Duo layout, posture, or panel screenshots, read the [Duo posture workflow](../../../app/docs/ios-simulator-pool.md#set-a-duo-posture) before selecting a device. Use the shared `scripts/duo-pose` command inside the simulator lease.
- Validate app UI through hosted XCTest and simulator tooling. Use those
  tools instead of Computer Use.
- Build and launch the app for UI or runtime changes, then provide a short manual
  simulator test plan.
- Install only normally signed builds for manual simulator testing. Builds made
  with `CODE_SIGNING_ALLOWED=NO` break Keychain entitlements when installed.

If simulator setup, selection, or raw `xcodebuild` fallback is needed, read the
relevant sections of [DEVELOPMENT.md](../../../app/DEVELOPMENT.md#local-validation-with-xcodebuildmcp).

Report each validation command and result. Distinguish failures caused by the
change from unrelated environment failures.
