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

App pull requests build all targets, run App unit and contract checks, and
launch the fixture App through opening a chat; they do not run the UI suite
(TAL-332). Main pushes run the full UI suite; the measuring performance UI
classes run on the scheduled UI Performance workflow. CI rejects a missing, failed, or skipped required launch smoke test.
CI matches the local runner's disabled automatic simulator diagnostic collection;
the XCTest result bundle and failure output remain available.

App source, Xcode configuration, test targets, scripts, CI helpers, release
fragments, app documentation, and upstream pins moved together into `app/` in
TAL-202. TAL-203 shares release fragments from root `changelog.d/`.
Their relative paths and runtime identity stay unchanged. Root community/legal
files, GitHub workflows, shared contract documentation, and agent configuration
remain at the root. `app/.gitignore` retains app-specific rules. Root instructions
and README become component routers; their original app content lives in `app/`.
`CLAUDE.md` remains a symlink to the root instructions.

App workflows run commands in `app/`; artifact paths stay relative to the
checkout. Release-note tooling reads root `changelog.d/` and historical
`app/changelog.d/` fragments, rejecting edits to historical fragments.

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
retargeting them. TAL-203 adds `app-v*`, `web-v*`, `web-exp-v*` and `relay-v*`
namespaces; see the [root release procedure](../releases/README.md).

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
| `.github/` | Shared root orchestration. Component checks use reusable workflows; `release-set.yml` coordinates releases through the authorized `production-cutover.yml` caller. Standalone release/deploy templates under `.github/release-templates/` remain inert. |
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
Native Docker and pnpm commands satisfy the existing root Actions allowlist;
the optional standalone lychee action is omitted. Optional Windows smoke remains manually dispatched; default verification uses
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
applies the reviewed integration tree delta, including binary files, regardless
of the recipe's merge topology. The original integration commits remain reachable
through `refs/remotes/migration/recipe`. It fetches and verifies each original
tag object, checks imported ancestry, runs `git fsck`, and requires its complete
tracked tree to equal the recipe commit's tree. Nothing is pushed or deployed.

## Public upstream imports

Public Hermes WebUI imports (`scripts/import-web-upstream`, `web/UPSTREAM_BASE_SHA`,
the weekly upstream watch) were retired when Talaria Web's backend was rewritten in
TypeScript (TAL-245). The original Web history stays reachable through the import
merge parents recorded above; no further upstream merges are expected.

## Validation boundaries

Root `scripts/check` exposes app, web, relay, contracts, Docker, tooling, and all
checks without a workspace framework. Server, sidecar, and browser tests get disposable
home/state directories. Convex checks use an anonymous local deployment with no
production credentials. Docker smoke uses unique project/container/volume names,
loopback-only ephemeral ports, and test-owned mounts for all three Compose variants.
The native Docker check also verifies state-directory UID detection and explicit
UID preservation. It runs on the existing macOS runner with Docker Desktop.
A trap/finally block cleans up only each check's resources.

CI classifies the complete PR or main-push diff with `scripts/changed-components.py`.
App, App tooling, Web server, Web frontend, Docker, Relay, shared contracts and
repository tooling have independent gates. A frontend change plus its changelog
fragment runs frontend checks; changelog-only edits run release metadata
validation without App tests. Documentation keeps its existing lightweight
checks. Shared contracts select their consumers, and unknown paths or missing
diff evidence select every suite. Renames include both old and new paths.
`CI Gate` always reports and requires success from every selected suite; an
unexpected skip fails the gate. Repository tooling always validates release
fragments and runs its full tests only when tooling is affected.
The release templates contain their original credentials and approvals but do
not execute during source consolidation.

The isolated launchers preserve an explicit `LD_LIBRARY_PATH` supplied by
the toolchain while dropping application credentials and state. The macOS contract
job runs the Node server on the fixture replay sidecar and needs no Agent. Diagnostic uploads are non-blocking;
the test result and job summary remain authoritative when artifact storage is
unavailable. Release-artifact validation and delivery remain separate strict gates.
