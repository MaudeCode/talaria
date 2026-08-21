# AGENTS.md — Talaria project instructions

Talaria is a native SwiftUI iPhone client for a self-hosted `hermes-webui`
server. Inherited documentation describes this project only where Talaria has
explicitly adopted it.

## Scope and issue tracking

- Kaneo project `Talaria` (`TAL`) is the canonical issue tracker. For issue work,
  read the human-selected Kaneo item and its linked context before coding.
- Move the selected issue to `In Progress` before changing code. After the work is
  committed and required validation passes, move it to `In Review` while it waits
  for human review. Move it to `Done` only after the commit is verified on `main`,
  whether merged through a PR or locally.
- Implement only the human-selected task or task batch. Do not pick another issue
  or invent backlog work. If selected work has no Kaneo issue, create one before
  coding.
- Read only the `PROJECT_SPEC.md` sections relevant to the task. Treat the spec as
  product intent; code, tests, configuration, `UPSTREAM_TESTED_SHA`, and
  `CONTRACT_TESTS.md` describe implemented behavior.
- Stop and ask when selected work conflicts with adopted product intent or an
  unresolved product question.

## Workflow boundaries

- `main` is the default release branch. Keep it buildable. For one issue, name the
  tracked-work branch `<type>/TAL-<number>-<slug>`. A human-selected issue batch
  may share one branch named for its lead issue or the batch.
- Commit each coherent, verified slice as it is completed so it has a rollback
  point. Start every tracked-work commit subject with the Kaneo key it addresses,
  for example `TAL-29: require ticket keys`; include every addressed key if a
  commit intentionally spans issues. Keep unrelated changes out of the commit.
- Pushing, opening or updating a PR, merging, and uploading a build each require
  explicit human approval.
- Triage automated review feedback before accepting it.
- Do not modify or restart the user's Hermes server, tunnel, macOS services,
  upstream checkout, or Apple resources unless explicitly asked.

## API and code rules

- For API requests, JSON decoding, SSE or streaming, and server-version
  compatibility, use `$talaria-upstream-contract`.
- Do not add a third-party package without approval.
- Do not commit a build or test failure caused by the change. Diagnose and report
  unrelated failures without expanding the task.

## Validation and handoff

- For XCTest and simulator validation, use `$talaria-ios-testing`.
- For signed physical-iPhone builds, installs, or launches, use
  `$talaria-device-deploy`.
- Report files changed, validation commands and results, and any unresolved risk.
  For docs-only changes, `git diff --check` is sufficient.
- Propose an `AGENTS.md` edit when these instructions drift; do not silently work
  around them.
