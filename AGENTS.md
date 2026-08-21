# AGENTS.md — Talaria project instructions

Talaria is a native SwiftUI iPhone client for a self-hosted `hermes-webui`
server. It was derived from Hermex, so inherited documentation describes this
project only where Talaria has explicitly adopted it.

## Scope and issue tracking

- Kaneo project `Talaria` (`TAL`) is the canonical issue tracker. For issue work,
  read the human-selected Kaneo item and its linked context before coding.
- Move the selected issue to `In Progress` before changing code. After the work is
  committed and required validation passes, move it to `In Review` while it waits
  for human review. Move it to `Done` only after the commit is verified on `main`,
  whether merged through a PR or locally.
- Implement only the selected task. Do not pick another issue or invent backlog
  work. If selected work has no Kaneo issue, create one before coding.
- Read only the `PROJECT_SPEC.md` sections relevant to the task. Treat the spec as
  product intent; code, tests, configuration, `UPSTREAM_TESTED_SHA`, and
  `CONTRACT_TESTS.md` describe implemented behavior.
- Stop and ask when selected work conflicts with adopted product intent or an
  unresolved product question.

## Workflow boundaries

- `main` is the default release branch. Keep it buildable and do implementation
  work on a short-lived branch.
- Commit each coherent, verified slice as it is completed so it has a rollback
  point. Keep unrelated changes out of the commit.
- Pushing, opening or updating a PR, merging, and uploading a build each require
  explicit human approval.
- Triage automated review feedback before accepting it.
- Do not modify or restart the user's Hermes server, tunnel, macOS services,
  upstream checkout, or Apple resources unless explicitly asked.

## API and code rules

- Never invent endpoints or JSON shapes. Inspect upstream at the exact
  `UPSTREAM_TESTED_SHA` for the supported contract. Use a running server to
  reproduce behavior for that server version; use official docs as secondary
  context.
- Do not add a third-party package without approval.
- Decode missing or version-varying response fields tolerantly, ignore unknown
  keys, and validate required values before use.
- Do not commit a build or test failure caused by the change. Diagnose and report
  unrelated failures without expanding the task.

## Validation and handoff

- Prefer terminal validation. Use XcodeBuildMCP when available; otherwise use
  `xcodebuild` and `xcrun simctl`.
- Run app UI validation through XCTest/XCUIAutomation and simulator tooling.
  Never use Computer Use to test Talaria.
- Run local XCTest only through `scripts/test-ios [test-identifier ...]`. Run a
  focused test first, wait for it to finish, then run the full suite before review
  or commit. Never overlap runs in one worktree; the script leases separate pooled
  simulators so different worktrees can test concurrently.
- Manual simulator installs must be signed. Never install a
  `CODE_SIGNING_ALLOWED=NO` build; Keychain login will fail.
- For UI or runtime changes, build and launch the app before handoff and include a
  short manual simulator test plan.
- Report files changed, validation commands and results, and any unresolved risk.
  For docs-only changes, `git diff --check` is sufficient.
- Propose an `AGENTS.md` edit when these instructions drift; do not silently work
  around them.
