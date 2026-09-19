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
