# AGENTS.md — working agreement for Talaria

Talaria is a native SwiftUI iPhone app (Xcode target/scheme `HermesMobile`, App Store
name `Talaria`) for a self-hosted `hermes-webui` server. `PROJECT_SPEC.md` is the
product/API source of truth — if a request conflicts with it, stop and ask.
Read by every agent (Codex, Claude Code, …); keep it tool-agnostic.

## Session start & wrap-up
- Read `CURRENT.md` first if it exists — it holds the latest resumable state. It is
  local-only (gitignored), never committed; a fresh clone won't have one.
- Read only the `PROJECT_SPEC.md` sections named in CURRENT.md's **Spec Read** field;
  never the whole ~850-line spec unless told to.
- Implement only the task the human selects or the task named in `CURRENT.md`; do not
  pull work from external trackers unless the human explicitly asks.
- On "wrap up": verify repo/build/test state, overwrite `CURRENT.md` with the new
  state (it stays uncommitted), then commit the code.
  History lives in `git log` and merged PRs; there is no append-only log.

## How work flows
- One scoped change → one short `chore/` or `fix/` branch → one PR.
- `main` is the protected release-candidate branch (the source for internal
  TestFlight builds): keep it buildable, never do feature work on it.
- Pushing a branch, opening/updating a PR, or merging needs explicit human approval.
  Triage bot/review comments before accepting them.

## Hard rules
1. **Never invent API endpoints or JSON shapes.** Verify in this precedence order:
   (a) `curl` your own running server — final arbiter; (b) the official API docs at
   https://get-hermes.ai/api-docs/ — best for endpoint intent, auth contract, SSE
   event vocabulary, and conventions (no version pin; tracks the latest release);
   (c) the pinned upstream copy at `.codex-tmp/hermes-webui/api/routes.py` — ground
   truth for exact JSON shapes, but may lag the release the docs describe (clone it
   if missing: `git clone https://github.com/nesquena/hermes-webui .codex-tmp/hermes-webui`).
   That upstream copy is read-only — never modify it (refreshing via `git pull` is fine).
2. **No new third-party dependencies** beyond the spec's locked list without approval.
3. **Tolerant decoding:** every `Codable` model uses optionals for fields upstream
   might add/rename. Never crash on unknown fields.
4. **No destructive commands** (`rm -rf`, `git push --force`, anything touching
   `~/Library/LaunchAgents/` or restarting Mac services). Suggest them; let the human run them.
5. **Don't commit broken builds.** If a build or test fails, fix it before writing more code.

## Tooling
- The maintainer works in Agentic Development Environments (Codex, Claude Code), not the Xcode UI — prefer terminal validation;
  ask to open Xcode only when the terminal can't answer.
- Use **XcodeBuildMCP** for simulator build/run/log; fall back to raw
  `xcodebuild`/`xcrun simctl` for release/archive or low-level diagnosis. Defaults live
  in `.xcodebuildmcp/config.yaml` (scheme `HermesMobile`); if that
  sim is missing, pick a nearby iPhone and say which.
- Run every local XCTest invocation through `scripts/test-ios [test-identifier ...]`.
  It serializes runs and isolates result bundles. Run the focused identifier first,
  wait for it to exit, then run `scripts/test-ios` for the full suite. Never start a
  direct or overlapping `xcodebuild test` process.
- **Simulator installs must be signed.** Never install a `CODE_SIGNING_ALLOWED=NO`
  build on the simulator for manual testing — that flag is for compile-only checks
  (see `TESTFLIGHT.md`) and strips entitlements, so Keychain writes fail with
  `errSecMissingEntitlement` and login breaks. Put the app on the sim via XcodeBuildMCP
  `build_run_sim` or a plain signed Debug build (no signing-disabling flags), then install/launch.
- Before asking for review or committing a slice: run `scripts/test-ios`, and
  build + launch the app for the human's manual simulator test when UI changed.

## App identity (resolved via xcconfig — not grep-able)
Bundle ID `dev.kil.talaria` · tests `….tests` · Team `Q28NF3NH3D` · App Store record/SKU not created yet.

## "push to branch testflight" (maintainer-only)
Upload the current branch to the side-by-side **Talaria Branch** internal TestFlight app
(`dev.kil.talaria.branch`) — a TestFlight upload, **not** a git push. This path is
unavailable until the owner creates its App Store Connect record.
Requires the maintainer's App Store Connect access; contributors never need this. Use a
unique `CURRENT_PROJECT_VERSION` (e.g. `YYYYMMDDHHMM`) each time. Full commands + branch
identity: `DEVELOPMENT.md`. Never touch the production `dev.kil.talaria` app
unless explicitly asked.

## Working with the human
- Surface tradeoffs in plain English before non-obvious choices; when in doubt, ask.
- Ask before touching anything under the spec's "Open questions."
- After each slice, report: (1) files changed (2) build/test command run (3) result
  (4) next suggested step — plus a short manual simulator test plan when UI changed.

## Keep this file honest
If something here surprises you or contradicts the project, tell the developer and
**propose** an AGENTS.md edit — don't silently edit it. This file is a Band-Aid for what
can't be fixed in code/tests/tooling; your proposed edits are also a signal of what to fix structurally.
