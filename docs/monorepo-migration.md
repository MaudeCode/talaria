# Source migration

TAL-202 consolidates tracked source without production cutover. TAL-203 owns
release integration; TAL-204 owns active-work reconciliation and live cutover.

## Source heads

| Component | Source | Revision |
|---|---|---|
| App | MaudeCode/talaria main | a74e56c6551aa8c0f7e99c146c172ae523ee5ea2 |
| Web | MaudeCode/hermes-webui master | 01e1582dd8abd87a7f1020e8a930b69466cd0cf6 |
| Relay | MaudeCode/talaria-relay main | 0263205690d8448c075c74e894fa8632c7c7a8b4 |

These are source-consolidation inputs, not a production freeze. Active changes
and final standalone heads must be reconciled again by TAL-204.

## App ownership

App source, Xcode configuration, test targets, scripts, CI helpers, release
fragments, app documentation, and upstream pins move together into `app/`.
Their relative paths and runtime identity stay unchanged. Root community/legal
files, GitHub workflows, shared contract documentation, and agent configuration
remain at the root. `app/.gitignore` retains app-specific rules. Root instructions
and README become component routers; their original app content lives in `app/`.
`CLAUDE.md` remains a symlink to the root instructions.

App workflows run commands in `app/`; artifact paths stay relative to the
checkout. Release-note tooling reads historical root-level fragments and new
`app/changelog.d` fragments, rejecting edits to historical fragments.

## Reachable-history scanning

Gitleaks 8.30.1 scans every reachable source commit with `--redact` and explicit
`--log-opts='--all --full-history --format=medium'`. Explicit formatting matters:
a local `format.pretty=oneline` causes the scanner to report zero commits.
Use `.gitleaksignore` only for the individually reviewed fingerprints below.
Private redacted reports remain outside tracked source.

The initial source scans found 19 false positives:

- App: one UserDefaults cache key and two synthetic shell-command redaction fixtures.
- Web: fourteen synthetic provider/redaction test literals, including repeated
  historical versions, and one plugin descriptor identifier in a response fixture.
- Relay: PEM-header matching code in the historical enrollment helper, with no
  embedded private-key material.

These findings do not justify file-wide or rule-wide exceptions. A new finding
requires inspection before adding its exact fingerprint.

After exact-fingerprint review, source scans passed: 503 app, 6,358 Web, and
57 Relay commits with additions inspected. Merge-only commits explain the
difference from full ancestry counts. Source `git fsck --full --no-dangling`
passed for Web and Relay. Inventories found no tracked local `.env`, virtualenv,
dependency, or Python cache artifacts.

The source inventories contain seven app tags, no Web tags, and thirteen Relay
tags, with no collisions. Preserve existing tag objects without resigning or
retargeting them; future release namespaces belong to TAL-203.

Historical tag publication is a separate approved cutover operation. In
particular, Relay's old tag trees contain standalone `push: v*` deployment
workflows. Do not publish historical tags with a bulk `git push --tags`; the
cutover must suppress release/deploy execution and verify the original tag
objects before enabling monorepo release entry points. Local preservation and
rehearsal do not authorize a production tag push.

## Import commits and root reconciliation

`monorepo-sources.json` records immutable source revisions, original tag objects,
and the app-move/Web-import/Relay-import commit mapping. Imports use
`git subtree add` without `--squash`; original commit authors, hashes, and public
upstream ancestry remain reachable through the import merge parents.

| Colliding item | Recorded ownership |
|---|---|
| `.github/` | Shared root orchestration. App workflows remain; Web and Relay checks have prefixed reusable workflows. Standalone release/deploy workflows are inert templates under `.github/release-templates/` until TAL-203. |
| `FUNDING.yml` | Root funding remains canonical; original Web attribution is preserved as `.github/WEB_FUNDING.yml`. |
| `.gitignore` | Root rules protect shared local state; component rules retain toolchain-specific exclusions. |
| `.gitattributes` | Root owns LF text rules; Web retains generated-dist attributes in `web/.gitattributes`. |
| `AGENTS.md` | Root routes components; app and Web retain their scoped rules; Relay has an explicit local/production boundary. |
| `README.md` | Root component index plus component-owned setup/runtime documentation. |
| `CONTRIBUTING.md` | Root repository policy and app setup; Web's detailed contribution policy stays in `web/`. |
| `LICENSE` | One shared root MIT license retains both original copyright notices. `web/NOTICE` preserves the complete upstream notice inside Python/container distributions. |
| `CHANGELOG.md` | Component-owned historical release notes remain under `app/` and `web/`. |
| `docs/` | Component docs stay with components; migration and shared contract documentation stay at root. |
| `scripts/` | Native component scripts stay with components; root scripts dispatch validation and history operations. |
| Agent/tool configuration | `.agents/`, `.codex/`, `.agy/`, and `.xcodebuildmcp/` remain at root, with corrected app paths. |

The app's Xcode project, source, entitlements, identifiers, and package resolution
remain byte-identical after relocation. Shared contract tests use the existing
test target. Python packaging resolves Git at the shared root and selects only `web-v*`
version tags, preventing app or Relay tags from becoming Web package versions.
The source updater's monorepo distribution behavior is TAL-203; the
standalone updater is intentionally not enabled against the whole monorepo here.
Optional Windows smoke remains manually dispatched; default verification uses
existing self-hosted runners without introducing hosted-runner charges.

## Repeat the migration

Authenticate `gh` with read access to the three private source repositories.
The rehearsal disables unrelated Git configuration and uses the existing `gh`
credential helper for source fetches, without copying credentials into Git.
From a committed migration checkout, run twice with distinct nonexistent paths:

```sh
python3 scripts/rehearse-monorepo.py /tmp/talaria-rehearsal-a
python3 scripts/rehearse-monorepo.py /tmp/talaria-rehearsal-b
```

Each rehearsal starts with a fresh app clone at the recorded source commit,
replays the reviewed app move, imports both original component histories, and
replays the reviewed integration commits. It fetches and verifies each original
tag object, checks imported ancestry, runs `git fsck`, and requires its complete
tracked tree to equal the recipe commit's tree. Nothing is pushed or deployed.

## Public upstream imports

From a clean monorepo checkout:

```sh
scripts/import-web-upstream <public-upstream-sha>
python3 scripts/test-monorepo-import.py
scripts/check web
scripts/check contracts
```

The command fetches the selected public commit into a dedicated
`refs/remotes/hermes-upstream/selected` ref and uses Git's `ort` merge with
`-Xsubtree=web`. The original Web history supplies the real merge base. Review
the uncommitted result, resolve any conflicts, and commit only after validation.
The synthetic proof covers nonconflicting updates, retained downstream edits,
untouched app files, ancestry, dirty-state rejection, and conflicting edits.

## Validation boundaries

Root `scripts/check` exposes app, web, relay, contracts, Docker, tooling, and all
checks without a workspace framework. Python and browser tests get disposable
home/state directories. Convex checks use an anonymous local deployment with no
production credentials. Docker smoke uses unique project/container/volume names,
loopback-only ephemeral ports, and test-owned mounts for all three Compose variants.
A trap/finally block cleans up only each check's resources.

CI routes component paths individually. Shared policy/docs and interface paths
run all affected components and contract validation. Main pushes run every
component. `CI Gate` always reports, including when component jobs are skipped.
The release templates contain their original credentials and approvals but do
not execute during source consolidation.

The Web forward-lint gate compares against the verified pure Web import when
the PR base predates `web/`. It checks the import tree against the recorded
standalone source and requires that import to be an ancestor. Later PRs use
their normal merge base. Existing upstream lint debt remains visible in the
informational report; integration edits still pass the forward gate.
