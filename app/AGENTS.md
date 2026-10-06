# Talaria app instructions

Commands and source paths below are relative to `app/`. Root policy is in
`../AGENTS.md`; shared workflow files stay in `../.github/`.

Talaria is a native SwiftUI iPhone client for a self-hosted Talaria Web server
(`../web/`).

## Scope and workflow

- Root `../AGENTS.md` owns the Kaneo tracker, ticket states, branch and commit
  naming, release-note fragments, and publication gates. Follow it for App work.
  If selected work has no Kaneo issue, create one before coding.
- Code, tests, configuration, and `../CONTRACT_TESTS.md` describe implemented
  behavior; app contracts are checked against the local `../web/`. `CONTEXT.md`
  defines the domain vocabulary.
- Stop and ask when selected work conflicts with product direction or an
  unresolved product question.
- Keep `main` buildable. The active `Protect main` ruleset requires pull
  requests, `CI Gate`, and verified signatures on new commits.
- Follow [release-note authoring](docs/release-notes.md) for the
  `../changelog.d/TAL-<number>.json` schema and validation command.
- Triage automated review feedback before accepting it.
- Do not modify or restart the user's Hermes server, tunnel, macOS services, or
  Apple resources unless explicitly asked.

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
