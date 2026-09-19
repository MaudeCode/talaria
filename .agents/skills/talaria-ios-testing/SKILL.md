---
name: talaria-ios-testing
description: Run Talaria XCTest and simulator validation for code changes. Use for focused or full test requests, simulator build-and-launch checks, UI runtime validation, and pre-commit verification.
---

Run app commands from `app/`; unqualified source and tooling paths are relative
to `app/`. GitHub workflows and shared contract documentation remain at the root.

# Talaria iOS testing

Use terminal validation. Prefer XcodeBuildMCP when it is available; otherwise use
`xcodebuild` and `xcrun simctl`.

## XCTest

Run local XCTest only through `scripts/test-ios [test-identifier ...]`.

1. Run the smallest focused test identifier that covers the change.
2. Wait for it to finish.
3. Run `scripts/test-ios` for the full suite before review or commit.

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
