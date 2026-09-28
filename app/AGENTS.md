# Talaria app instructions

Commands and source paths below are relative to `app/`. Root policy is in
`../AGENTS.md`; shared workflow files stay in `../.github/`.

Talaria is a native SwiftUI iPhone client for a self-hosted Talaria Web server
(`../web/`).

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
- Code, tests, configuration, and `../CONTRACT_TESTS.md` describe implemented
  behavior; app contracts are checked against the local `../web/`. `CONTEXT.md`
  defines the domain vocabulary.
- Stop and ask when selected work conflicts with product direction or an
  unresolved product question.

## Workflow boundaries

- `main` is the default release branch. Keep it buildable. For one issue, name the
  tracked-work branch `<type>/TAL-<number>-<slug>`. A human-selected issue batch
  may share one branch named for its lead issue or the batch.
- The active `Protect main` ruleset requires pull requests, `CI Gate`, and verified
  signatures on new commits. CI must validate every push to `main`.
- Commit each coherent, verified slice as it is completed so it has a rollback
  point. Start every tracked-work commit subject with the Kaneo key it addresses,
  for example `TAL-29: require ticket keys`; include every addressed key if a
  commit intentionally spans issues. Keep unrelated changes out of the commit.
- Every tracked PR must add `../changelog.d/TAL-<number>.json` for each addressed
  ticket, including an explicit skip reason for repository-only work. Before
  committing or opening a PR, follow [release-note authoring](docs/release-notes.md)
  for the JSON schema, commit/PR format, and validation command. Agents author
  these fragments as part of implementation; signed releases generate the final
  Markdown and JSON automatically.
- Pushing, opening or updating a PR, merging, and uploading a build each require
  explicit human approval.
- Pass `--repo MaudeCode/talaria` to repository-scoped `gh` commands; do not
  infer the target from local remotes.
- Triage automated review feedback before accepting it.
- Do not modify or restart the user's Hermes server, tunnel, macOS services,
  upstream checkout, or Apple resources unless explicitly asked.

## API and code rules

- For API requests, JSON decoding, SSE or streaming, and server-version
  compatibility, use `$talaria-upstream-contract`.
- Never invent API endpoints or JSON shapes; verify them against the Web
  contracts or a running server. Every `Codable` model decodes tolerantly and
  never crashes on unknown fields.
- Follow root server-owned state (`../AGENTS.md`): views and view models render
  decoded contract fields; derivation from server data goes on the server
  through `$talaria-upstream-contract`.
- Before adding code, inspect nearby callers and existing helpers. Reuse or
  consolidate behavior with multiple callers, delete obsolete code, keep files
  and types cohesive, avoid single-use abstractions, and create a Kaneo follow-up
  when necessary cleanup is too broad for the selected task.
- Keep the Settings root as a category directory. Put new controls in their
  owning category. A new root category needs a distinct user-facing concern;
  a direct root action needs explicit justification as unusually important.
  User Profile and Sign in with Apple are the approved root exceptions.
- Do not add a third-party package without approval.
- Automated tests must run from deterministic, isolated, test-owned state in a
  clean environment. Fixture identifiers must be synthetic, and the harness must
  create every dependency it uses. Treat reliance on pre-existing accounts,
  credentials, services, or application data as a failing test design.
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
