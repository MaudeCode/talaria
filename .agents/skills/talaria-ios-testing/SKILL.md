---
name: talaria-ios-testing
description: Run Talaria XCTest and simulator validation for compiled App changes, explicit test requests, and simulator runtime checks. Use targeted tooling checks for CI scripts, documentation, and release-note edits.
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
3. For non-UI App changes, run `swift test --package-path TalariaKit` and `scripts/test-ios TalariaTests TalariaUITests/ChatNavigationUITests/testChatSessionOpensFromList` before review or commit. HTTP/SSE changes also require the contract checks. Run `scripts/test-ios` for UI changes or uncertain scope.

CI (pull requests and main pushes) boots no simulator: every App change runs
`swift test` for TalariaKit and builds the App, its extensions and both test
bundles for testing (TAL-399). The simulator-hosted tests, the launch smoke test
and the UI suite run in four shards plus the package job nightly and as a
release gate (`.github/workflows/ui-suite.yml`), not before merge, so run step 3
locally, and the UI suite for UI changes, before review (TAL-332).

The script serializes runs within one worktree and leases pooled simulators across
worktrees. Let the current run finish instead of starting an overlapping run.

## Simulator validation

- Validate app UI through XCTest, XCUIAutomation, and simulator tooling. Use those
  tools instead of Computer Use.
- Build and launch the app for UI or runtime changes, then provide a short manual
  simulator test plan.
- Install only normally signed builds for manual simulator testing. Builds made
  with `CODE_SIGNING_ALLOWED=NO` break Keychain entitlements when installed.

If simulator setup, selection, or raw `xcodebuild` fallback is needed, read the
relevant sections of [DEVELOPMENT.md](../../../app/DEVELOPMENT.md#local-validation-with-xcodebuildmcp).

Report each validation command and result. Distinguish failures caused by the
change from unrelated environment failures.
