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

Run local XCTest only through `scripts/test-ios [test-identifier ...]`.

1. Run the smallest focused test identifier that covers the change.
2. Wait for it to finish.
3. For non-UI App changes, run `scripts/test-ios TalariaTests TalariaUITests/ChatNavigationUITests/testChatSessionOpensFromList` before review or commit. HTTP/SSE changes also require the contract checks. Run `scripts/test-ios` for UI changes or uncertain scope.

PR CI runs only the focused set for every App change, so run the UI suite
locally for UI changes before review: CI no longer does it before merge (TAL-332).
Every selected App run still builds all targets once, then CI splits the tests
across hosted simulators with `ci/test_shards.py` (two shards for a PR, four for
the full main suite). The launch smoke test must
execute and pass; absence or skipping fails CI. Main pushes run the full UI suite.

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
