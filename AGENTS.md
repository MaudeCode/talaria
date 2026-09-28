# Talaria monorepo

Read the selected component instructions before edits: `app/AGENTS.md` for the
Apple app, `web/AGENTS.md` for Talaria Web, and `relay/AGENTS.md` for Relay.
Shared machine-readable interfaces belong in `contracts/`; cross-component
changes must validate every affected consumer. Run component commands from
their component directory. GitHub workflow orchestration stays at the root.

Server-owned state: clients are display-only. The Web server
(`web/packages/server` and its sidecar) computes every decision,
classification, derivation, normalization, pairing, ordering, filtering,
redaction, and computed value a client shows, and ships each one as an explicit
field defined in `web/packages/contracts`; the generated
`contracts/web-api.openapi.json` and `contracts/fixtures/` follow. Clients
render those fields. Client logic is limited to localized wording; number,
date, and unit formatting; local-date bucketing; layout, theme, animation, and
accessibility; device-local UI state (disclosure, scroll, focus, drafts);
live-stream rendering before the server persists a value, converging on the
server field once it arrives; offline display of cached server fields; and
platform integration (notifications, Live Activities, share sheets, input).
Everything else, including anything uncertain, belongs on the server; when the
server lacks the data, add it to the server or sidecar. A change that adds or
edits client logic outside that list moves it to the server and contract in the
same change, or files a linked Kaneo ticket before merge and cites it in the
PR; reviewers treat unticketed client derivation as blocking. An old-server
fallback sits behind the contract field and is deleted once the field ships.

Kaneo Talaria is the canonical tracker for all components. Add one or more scope
labels: `app`, `web`, `relay`, `tooling`, `contracts`. Use `contracts` alongside
the affected components for shared schema/protocol work; CI and agent tooling
use `tooling`. Keep work-type (`ci`, `bug`, etc.), difficulty, and readiness
labels separate. Web uses one scope label rather than frontend/backend labels.
Work only on the selected ticket and its required dependencies. Move it to In
Progress before edits, In Review after verified commits, and Done only after its
commit is verified on `main`.
Use `<type>/TAL-<number>-<slug>` branches and `TAL-<number>:` commit/PR subjects.
Keep coherent verified slices separate. Add `changelog.d/TAL-<number>.json`
following `app/docs/release-notes.md` for every tracked change.
Screenshots and other validation evidence go in the PR description as uploaded
attachments, never in git. Images are committed only as shipped or tested assets
(asset catalogs, `web/static/brand/`, App README images, snapshot-test
references); `scripts/check-committed-images.py` enforces this on every PR.

Pushing, PR publication/updates, merging, releases, deployments, TestFlight
uploads, repository administration, and archival retain explicit human gates.
Use `--repo MaudeCode/talaria` with repository-scoped `gh` commands.
Preserve unrelated work and component runtime identities. Keep component
credentials isolated. Do not change live services.
Tests must own synthetic disposable state and never depend on live accounts.
Do not add third-party dependencies without approval.

For validation, route the actual diff with `scripts/changed-components.py`
(`--merge-base` for a PR, before/after commits for a push). Scope labels do not
select tests. Changelog-only changes require release-note validation; docs and
CI/tooling-only edits do not by themselves require XCTest. Unknown paths or an
unreadable diff select the full suite. Shared contracts select their consumers.
