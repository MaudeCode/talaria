---
name: hermes-agent-release-review
description: Read-only review of an exact Hermes Agent (NousResearch/hermes-agent) release or main SHA for new, modified, deprecated and removed behavior relevant to Talaria Web. Use when a new Agent release or main canary needs a feature and deprecation report, or when asked what changed in the Agent since the last review. Not for the Hermex iOS fork or Talaria's own contract.
---

# Hermes Agent release review

Produce an evidence-linked report for one exact Agent range. The review is
advisory: it never changes Talaria source, `web/sidecar/agent_dependency.json`,
Kaneo, or a deployment, and its result is not a compatibility pass/fail or a
feature-adoption decision.

## 1. Prepare the exact range

From the monorepo root:

```sh
python3 scripts/review-agent-range.py prepare --candidate <tag|main|SHA> \
  [--base <reviewed tag|SHA>] [--state <state.json>] [--checkout <disposable dir>]
```

- `--candidate main` resolves to one exact SHA (`kind: unreleased`); review that
  SHA only. Unreleased code is never described as supported.
- The base defaults to `lastReviewed.sha` in the state file. Keep the state file
  outside the repository; its `lastObserved` and `lastPassing` fields belong to
  the release monitor and canary and are never edited here.
- `status: complete` means the checkout holds the whole range. `history_missing`
  or `not_ancestor` ends the review: report it with both SHAs and do not pick a
  narrower range. `already_reviewed` means the watermark already covers this
  SHA; report that and stop.

The manifest lists the compare link, non-merge commit count, changed files per
area, and `sidecarModules`: the changed Agent modules the sidecar imports.

## 2. Read the change

In the checkout (`git log --no-merges <base>..<candidate>`, `git diff`):

1. Release notes: `gh release view <tag> --repo NousResearch/hermes-agent`. Notes
   often defer the full changelog, so treat them as leads, not coverage.
2. Every `sidecarModules` entry: diff the functions and names the sidecar
   imports or calls. A removed or re-signatured name is a compatibility
   adaptation. A name re-exported lazily (module `__getattr__` map) still exists.
3. The `hermes` CLI verbs the sidecar runs (`gateway restart` in
   `web/sidecar/talaria_sidecar/methods/gateway.py`) and Agent-owned file formats
   the server reads (`config.yaml`, `.env`, profiles, skills, memories, `state.db`;
   see `web/docs/architecture/agent-api-contract.md`).
4. New capabilities in areas Talaria already exposes (the dependency-class table
   in that document): commits whose subject is `feat(...)`, new CLI verbs, new
   config keys, new control-socket verbs, new `state.db` columns.

Map each finding to Talaria's consumer: sidecar method, its schema in
`web/packages/contracts/src/sidecar/namespaces.ts`, the server route, and UI.

## 3. Classify and report

Classify every relevant change as exactly one of:

- **already exposed**: Talaria already offers it; no change needed.
- **compatibility adaptation**: a sidecar call breaks or changes meaning.
- **optional Talaria feature**: a new Agent capability Talaria does not expose.
- **deprecation/removal**: an interface Talaria uses is deprecated or gone.
- **irrelevant**: outside every Talaria boundary. Summarize these by area; do
  not list them one by one.

Report sections: identity (candidate ref, SHA, kind, base SHA, compare link,
commit count), findings per class (GitHub commit or blob link at the exact SHA
plus a Talaria `path:line`), unresolved uncertainty, and the support-test result
from `python3 scripts/check-agent-compatibility.py` if run for this identity
(otherwise "not run"). Keep findings older than the base out of the classes;
list them under uncertainty as outside the reviewed range.

Link to upstream sources, never to the checkout. The report contains no
credentials, local home paths, or live session content.

## 4. Advance the watermark

Only after the report is complete:

```sh
python3 scripts/review-agent-range.py advance --state <state.json> \
  --ref <candidate ref> --sha <candidate SHA> --report <report file>
```

It refuses a report that does not name the SHA or that contains a home path or
token, and rewrites nothing when the watermark is unchanged. A failed or missing
review leaves the watermark where it was.
