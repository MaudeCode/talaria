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
- Before any view change, read `../docs/design-system.md`: plain lists on the
  system background, no cards or grouped inset backgrounds, the Insights rows as
  the reference, shared components (`SidebarList`, `ProgressRailView`,
  `ProviderQuotaMetricCell`) over new ones.
- Do not modify or restart the user's Hermes server, tunnel, macOS services, or
  Apple resources unless explicitly asked.

App UI rules run from the repository root with
`node scripts/check-ui-rules.mjs --config app/ci/ui-rules.json`. After removing a
counted violation, rerun with `--update` to lower `app/ci/ui-rules-baseline.json`.
It never raises counts. An approved exception is a hand-written entry in that
baseline's `exceptions` array, `{ "rule": "settings-footnote", "file":
"app/Talaria/Features/Settings/Example.swift", "count": 1, "reason": "status text" }`.
Every exception requires a non-empty reason.

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
- Put new catalog keys at their sorted position; from the repository root run `app/ci/check-string-catalogs --fix` after edits or resolving a catalog conflict.
- Group the Settings root into Interface, Profile, Server and This iPhone.
  Put a new control in an existing section of the group its storage belongs to
  (`../docs/design-system.md` §11). Reuse the shared rows in
  `Talaria/Features/Settings/Settings*Row.swift` for their control type (§12).
  A new root category needs a distinct user-facing concern;
  a direct root action needs explicit justification as unusually important.
  User Profile and Sign in with Apple are the approved root exceptions.
  Settings categories are owned by scope, in this order:

  | Group | Categories |
  | --- | --- |
  | Interface | Appearance, Chats, Navigation, Notifications & Haptics, Speech |
  | Profile (active profile name) | Models, Providers, Tools |
  | Server (active server name) | Profiles, Workspaces, System |
  | This iPhone | Servers, Live Activities & Widgets, Siri & Shortcuts, Data & Storage, About, Developer (DEBUG) |

  Shared ids, grouping and relative order follow `contracts/fixtures/settings-sections.json`.
  About describes the installed app and is the one shared id under This iPhone.
- Automated tests must run from deterministic, isolated, test-owned state in a
  clean environment. Fixture identifiers must be synthetic, and the harness must
  create every dependency it uses. Treat reliance on pre-existing accounts,
  credentials, services, or application data as a failing test design.
- Do not commit a build or test failure caused by the change. Diagnose and report
  unrelated failures without expanding the task.

## Validation and handoff

- For XCTest and simulator validation, use `$talaria-ios-testing`.
- A UI change attaches the [screen gallery](docs/visual-references.md#screen-gallery) screenshots of each page it touches to the PR.
- For an explicitly requested physical iPhone install, run
  `scripts/run-ios-device --no-launch` from `app/`.
- Report files changed, validation commands and results, and any unresolved risk.
  For docs-only changes, `git diff --check` is sufficient.
- Propose an `AGENTS.md` edit when these instructions drift; do not silently work
  around them.
