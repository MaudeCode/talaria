---
name: upstream-release-review
description: Review one exact release range of a Talaria upstream (Hermes Agent, Hermex, or Hermes WebUI) for changes Talaria should adopt, fix, or track, then file every bug and feature in Kaneo, deciding product choices, and hold only owner-only decisions. Use when a new upstream release needs review, when the upstream release monitor launches a review thread, or when asked what changed upstream since the last review.
---

# Upstream release review

Review one exact range, `<base>..<candidate>`, of one upstream:

| Upstream | Repository | Talaria consumer | Review covers |
|---|---|---|---|
| Hermes Agent | `NousResearch/hermes-agent` | Web sidecar, contracts, server, UI | compatibility and features |
| Hermex | `uzairansaruzi/hermex` | `app/` (Talaria's App is a Hermex fork) | fixes and features to port |
| Hermes WebUI | `nesquena/hermes-webui`, including `exp-*` | `web/` (Talaria Web derives from it) | features, plus fixes for defects Talaria Web shares |

Talaria Web is no longer the Python WebUI build, so WebUI changes never create
compatibility work. Count a WebUI fix only when Talaria Web shows the same
user-visible defect.

The review never edits Talaria source, the Agent pin, or a deployment. Its only
tracker writes are the ones in step 4.

## 1. Pin the range

Resolve both ends to exact SHAs. Missing or rewritten history ends the review:
report both SHAs and do not choose a narrower range. An empty range is reported
and stops the review.

- **Hermes Agent:** from the monorepo root, run:
  ```sh
  python3 scripts/review-agent-range.py prepare --candidate <tag|main|SHA> \
    --base <base> --state ~/.talaria-release-reviews/hermes-agent.json
  ```
  `--candidate main` reviews one exact unreleased SHA, which is never called
  supported. `already_reviewed` means the watermark covers the candidate; report
  that and stop. The manifest's `sidecarModules` lists the changed Agent modules
  the sidecar imports.
- **Hermex and WebUI:** clone into a new temporary directory outside the
  repository (`gh repo clone <repo> <dir> -- --filter=blob:none`). Verify that
  `<base>` is an ancestor of `<candidate>`, and list
  `git log --no-merges <base>..<candidate>`.

## 2. Read every change

Release notes are leads, not coverage. Read each release note in the range (`gh
release view <tag> --repo <repo>`) and then every non-merge commit's body, stat,
and relevant patch. When a range is too large for one pass, partition its
commits by the paths they touch and review the partitions in parallel. Every
commit still gets its body and stat read, whatever its path or subject; read the
patch wherever the body or stat touches a Talaria boundary or adds a CLI verb,
config key, persisted field, or other user-visible capability. Each partition
reviewer's uncertainty and open-question notes join the review: verify every one
and classify it with step 3's classes, or put it in the report's Uncertainty
when it cannot be resolved. Review against current `origin/main`. Before filing,
run `git fetch origin`; when `origin/main` moved during the review, re-check
each finding against the new head.

- **Hermes Agent:** diff each `sidecarModules` entry for the names the sidecar
  imports or calls. A removed or re-signatured name breaks compatibility; a name
  re-exported lazily (module `__getattr__` map) still exists. Also check the
  `hermes` CLI verbs the sidecar runs (`gateway restart` in
  `web/sidecar/talaria_sidecar/methods/gateway.py`) and the Agent-owned files
  the server reads (`config.yaml`, `.env`, profiles, skills, memories,
  `state.db`; see `web/docs/architecture/agent-api-contract.md`). New
  capabilities are `feat(...)` commits, CLI verbs, config keys, control-socket
  verbs, and `state.db` columns in areas from that document's dependency-class
  table.
- **Hermex:** map `HermesMobile` paths and types to their current Talaria
  equivalents, then read current callers, tests, and history. Compare behavior,
  not commit titles. Plan semantic ports, not cherry-picks, so Talaria naming,
  module paths, navigation, activity timelines, and multi-server isolation
  survive. When adopting a change needs a request, response, or SSE shape the
  Talaria Web contract (`web/packages/contracts`) lacks, file it with the
  server and contract work in the same ticket when the code decides that shape.
  It is a contract hold only when the shape needs an owner decision.
- **Hermes WebUI:** map each user-visible capability to `web/packages/server`,
  `web/sidecar`, and `web/packages/frontend`. Ignore Python-server internals.

Map every finding to its Talaria consumer with a `path:line`.

## 3. Classify

Put each relevant change in exactly one class:

| Class | Meaning | Outcome |
|---|---|---|
| **bug** | Talaria has the same reachable defect, or breaks against the candidate | file |
| **feature** | a new upstream capability Talaria users would gain | file |
| **already present** | Talaria already has it or a stronger equivalent | report |
| **hold** | an owner-only decision: it needs a credential or a paid or external account, makes an irreversible or outward-facing change, or conflicts with a recorded owner preference | hold for approval |
| **irrelevant** | outside every Talaria boundary | summarize by area |

Decide everything else. A product choice, intentional divergence, security
posture, deprecation, or contract shape is decided from the way Talaria already
solves the same class of problem, and the ticket records the decision and its
reason (the `kaneo` skill's readiness rules). Hold nothing that a competent
engineer could decide from the code.

A bug needs evidence that Talaria is affected: a reproduction with disposable
state, a failing existing check, or the cited Talaria `path:line` that has the
same reachable behavior. Reproduce first in the affected consumer: run the real
App, Web frontend, server, sidecar, or Agent code with disposable state (a
focused XCTest, a scratch vitest or pytest, a Playwright check, an isolated
server), and run it through to the consequence the finding claims, not
only its trigger. When the needed state cannot be synthesized, code inspection
is enough to file. Mark such a ticket **code-supported** and make a failing
test, written before the fix, its first acceptance criterion. Waste visible in code but unmeasured is filed the same way,
with a measurement or budget as its first acceptance criterion. A feature needs a
concrete user-visible outcome in Talaria. Group changes that share one Talaria
change into one finding. A Talaria defect older than the base is still a bug when
upstream fixed the same defect within the range: file it and mark it pre-range.

Irrelevant means no Talaria user would notice the difference. A different
mechanism is not irrelevant: compare what the user sees (for example, what a
notification says). A change that only matters to a capability a filed ticket
or a hold would add belongs to that finding, not to irrelevant.

## 4. File and hold

For every **bug** and **feature**, follow the `discover-tickets` skill's validation,
shaping, and filing sections in the Talaria Kaneo project. Use the investigation
question "What does `<repo>` `<base>..<candidate>` need from Talaria?". That
skill dedupes against open and recent tickets, branches, and PRs, decides `sf`
readiness, and reads tickets back. It is a user-level skill from
`kiliantyler/skills`, not part of this repository. When it is not installed,
file nothing and list every bug, feature, and support ticket under "Held for
approval" instead.
On top of its rules:

- Attach the workspace `upstream` label and the consumer's scope: `web` for the
  Agent and WebUI, `app` for Hermex. Add `contracts` when the change touches
  `web/packages/contracts`. Every ticket a Hermes Agent review files or comments
  on also gets `agent-compat`.
- Put the upstream release tag and commit, PR, or blob links (at exact SHAs) in
  the body.
- Follow the server-owned-state rule in the root `AGENTS.md`: client features
  get their decision fields on the server and in the contract.
- When an open ticket already covers the finding, comment on it with the new
  evidence instead of filing.
- When a ticket adds a server field that a client it does not cover must render,
  file that client's adoption ticket in the same run, blocked by the server
  ticket.
- For a Hermes Agent release tag, file one **support ticket**, "Support Hermes
  Agent `<tag>` and pin the Web sidecar to it", even when nothing blocks it.
  Every **bug** ticket this run files or comments on blocks it, as does each
  held finding once approved and filed as a bug. Its acceptance criteria:
  `scripts/check-agent-compatibility.py --release <tag>` passes,
  `web/sidecar/agent_support.json` holds the newest three releases, and
  `web/sidecar/agent_dependency.json` pins `<tag>`. An open support ticket for
  `<tag>` takes this run's blockers instead.

File nothing for a **hold**. List it in the report with its evidence and the
ticket you would file. The owner approves held findings by replying in the
review thread, and only then is that ticket filed.

## 5. Report

- **Identity:** upstream, base and candidate tags with SHAs, compare link, and
  non-merge commit count.
- **Filed:** each ticket link and the finding it covers, plus tickets commented
  on, and for a Hermes Agent release the support ticket with its blockers.
- **Held for approval:** numbered so the owner can approve by number.
- **Already present and irrelevant:** grouped summaries.
- **Uncertainty:** only what the review could not resolve, each with the step
  that would resolve it.
- **Hermes Agent only:** the support result from
  `python3 scripts/check-agent-compatibility.py --identity JSON` (a release) or
  `--main SHA` (a canary) when run for this identity, citing its receipt.
  Otherwise write "not run".

Link to upstream sources, never to the local clone. The report contains no
credentials, home paths, or live session content.

## 6. Advance the Agent watermark

Only for Hermes Agent, and only after the report is complete:

```sh
python3 scripts/review-agent-range.py advance \
  --state ~/.talaria-release-reviews/hermes-agent.json \
  --ref <candidate ref> --sha <candidate SHA> --report <report file>
```

It refuses a report that does not name the SHA or that contains a home path or
token. A failed or missing review leaves the watermark unchanged. The `lastObserved`
and `lastPassing` fields belong to the CI release detector and canary, so never
edit them here.
