# Talaria monorepo

Read the selected component instructions before edits: `app/AGENTS.md` for the
Apple app, `web/AGENTS.md` for Talaria Web, and `relay/AGENTS.md` for Relay.
Shared machine-readable interfaces belong in `contracts/`; cross-component
changes must validate every affected consumer. Run component commands from
their component directory. GitHub workflow orchestration stays at the root.

Kaneo Talaria is the canonical tracker. Work only on the selected ticket and its
required dependencies. Move it to In Progress before edits, In Review after
verified commits, and Done only after its commit is verified on `main`.
Use `<type>/TAL-<number>-<slug>` branches and `TAL-<number>:` commit/PR subjects.
Keep coherent verified slices separate. Add `app/changelog.d/TAL-<number>.json`
following `app/docs/release-notes.md` for every tracked change.

Pushing, PR publication/updates, merging, releases, deployments, TestFlight
uploads, repository administration, and archival retain explicit human gates.
Use `--repo MaudeCode/talaria` with repository-scoped `gh` commands.
Preserve unrelated work and component runtime identities. Keep component
credentials isolated. Do not change live services or upstream checkouts.
Tests must own synthetic disposable state and never depend on live accounts.
Do not add third-party dependencies without approval.

For source imports, history/tag reconciliation, or upstream integration, read
`docs/monorepo-migration.md`. Migration completion is separate from the
production cutover in TAL-204.
