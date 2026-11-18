# CI repair handoff

A failing test on a pull request, on `main` or in a release reaches one T3
dispatcher thread, which hands each root cause to one standalone repair worker
(TAL-2397). The worker reproduces the failure, decides its cause, fixes it,
merges its own repair PR and closes the incident ticket without an operator,
Factory, a scheduler job or a ticket claim.

Two T3 tasks feed the dispatcher thread, and both run
`scripts/main-ci-failure.py` from refreshed `origin/main`:

- **Webhook.** When a push run of `main`'s CI fails, its `Hand the failure to
  T3` job posts one signed failure report. The task runs `triage` on its run ID.
- **Scan.** Every 15 minutes, `scan` triages each CI and release run updated in
  the last 30 minutes that failed in any attempt or still runs. This is the path
  for pull request and release runs, and it recovers a main report that never
  arrived. A failed job is visible while the run's other jobs still run.

`triage` re-reads the run from GitHub, then rejects it, records a no-op,
updates the incident's repair thread, or launches one new top-level repair
thread in a worktree from refreshed `main`. Nothing in this path grants release,
deployment, device, secret, scheduler or repository-administration permissions.

## Incidents

An incident is one root cause, keyed by its failing test (from the App test log
or Playwright's annotation) or, without one, by its job and failed step. The
same test failing on a pull request, on `main` and in a release is one incident:
one repair thread titled `Repair main CI <key>: <test>`, one ticket and one PR,
whose body carries `main-ci-incident: <key>`.

| Run | Repaired when |
|---|---|
| `main` push | a test or step failed, unless a newer `main` run passed and no rerun of this commit passed |
| Pull request | a later attempt of the same head passed the failed job: the failure is intermittent. A failure no rerun passed stays with the pull request's owner |
| Fork pull request | as a pull request, and the worker never checks out, builds or runs the fork's code |
| Release (`production-cutover.yml`) | a test job failed (`app-hosted-tests`, `agent`, `contracts`, `component-contracts`). Build and publication jobs belong to the release recovery path |

A green rerun keeps the incident: it is evidence of an intermittent failure,
never a fix. A step that prepares the runner (setting up, installing, booting or
waiting for the simulator) and a lost runner are runner faults: the dispatcher
reports them for the CI harness owner and launches no test repair.

Deduplication: a repeated delivery, another attempt, another lane or a scan of
the same incident updates its repair thread. An open PR carrying the
incident's key owns it, so a restarted dispatcher that lost the thread opens no
competing repair. A scan launches each incident once. An incident whose repair
launches ended failed or cancelled twice gets a no-op for an operator.

## Repair worker

The launch message is the worker's whole instruction set
(`brief()` in the script, tested in `scripts/test-main-ci-failure.py`). It:

1. Finds or files the incident's ticket by its key, without claiming it.
2. Reproduces at the failing commit with the focused command and a bounded
   repetition (`app/scripts/test-ios --repeat`, `app/scripts/test-package
   --repeat`, Playwright's `--repeat-each`, or at most 20 runs), then replays
   the smallest group or environment that reproduces it.
3. Decides the cause from evidence: test, product, runner or harness, upstream
   or publication. A green retry is never a cause or a fix.
4. Follows the defect loop in [testing.md](testing.md) for a defective test, and
   fixes the product for a race the test rightly caught.
5. Publishes a PR with the key, a regression proof and the defect rule, asks
   for `@codex review`, and acts on the first actionable CI failure.
6. Merges with `scripts/main-ci-failure.py land --pr <number> --head <sha>`,
   which refuses a moved head, a PR from another repository, a body without the
   key or regression proof, and a head where CI Gate has not passed. It merges
   that exact head and reads the merge commit back on `main`.
7. Closes the ticket only after that readback. A blocked or unreproduced
   incident keeps its ticket open with a hold naming the blocker, its owner and
   what resumes it. For a release incident, the merge commit is the verified
   repair the release recovery path can re-release from.

### Worker authority

The setup below grants each repair thread exactly this, on this repository:
one `fix/TAL-<number>-<slug>` branch, one PR to `main`, `@codex review`
requests and replies on it, merging it with `land`, and the incident's Kanvil
ticket. The worker uses the `gh` login and Kanvil connection T3 already holds;
no token, GitHub App or repository setting is added. Branch protection still
requires CI Gate on the merged head. It never pushes to another branch,
including a source pull request's, and a flake never authorizes a release, a
deploy or replaying a partial publication.

Pull requests build the App and run its package tests but leave out the
simulator-hosted unit tests unless they carry the `hosted-tests` label, so a
hosted-test regression usually surfaces here first, on the `main` push that
introduced it.

## Pull request failure report

A pull request run's `Report the first failure` job (TAL-2395) polls the run's
jobs every 30 seconds with `scripts/main-ci-failure.py watch` and keeps one PR
comment current from the first failure on, while other jobs still run. Each
failed job gets its failed test or step, a local reproduction command from the
script's trusted table, and its job log, plus its result bundle or Playwright
results when uploaded. An App test that fails mid-shard is known before its job
ends from the commit status `app/ci/report-test-failures` posts, so its line
names the test and `app/scripts/test-ios --repeat 3 <identifier>`. Infrastructure
faults, timeouts and cancellations are labelled apart from failing tests.

The comment carries the PR head, the tested merge commit, the run and attempt.
A run whose PR head moved on, or an earlier run of the same head, never
overwrites it; a new head's run marks it current, and a same-head rerun reports
its attempt and, once it passes, the resolution. The job fails once it reported
a failure so "Re-run failed jobs" includes it. CI Gate does not need it, and it
never dispatches a main repair. A fork's pull request runs with a read-only
token: its report is this job's log and summary.

## Pieces

| Piece | Where |
|---|---|
| Sender | `alert` job in `.github/workflows/ci.yml`, running `scripts/main-ci-failure.py send` |
| Receiver | a T3 webhook scheduled task with HMAC verification (`x-hub-signature-256`, hex, `sha256=` prefix) |
| Scan | a T3 interval task bound to the dispatcher thread, running `scripts/main-ci-failure.py scan` |
| Dispatcher prompts | `python3 scripts/main-ci-failure.py prompt` (webhook) and `prompt --scan` |
| Decisions | `scripts/main-ci-failure.py triage` and `scan`, tested by `scripts/test-main-ci-failure.py` |
| Merge | `scripts/main-ci-failure.py land`, run by the repair worker |
| Secrets | `MAIN_CI_WEBHOOK_URL` and `MAIN_CI_WEBHOOK_SECRET` Actions secrets, read only by the `alert` job |

## Setup (owner-approved)

1. In T3, open a thread in the Talaria project titled `Main CI repair dispatcher`.
2. From that thread, call `request_secret` for the signing secret, then
   `schedule_task` with the prompt printed by
   `python3 scripts/main-ci-failure.py prompt`, `bindToCurrentThread: true`, and
   `schedule: {type: "webhook", maxDeliveryAgeMinutes: 720, signature: {header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secretRef: <ref>}}`.
3. Set the same secret and the returned `webhookUrl` as repository secrets
   without echoing them: `gh secret set MAIN_CI_WEBHOOK_SECRET --repo MaudeCode/talaria`
   and `gh secret set MAIN_CI_WEBHOOK_URL --repo MaudeCode/talaria`, each
   reading the value from standard input.
4. From the dispatcher thread, call `schedule_task` with the prompt printed by
   `python3 scripts/main-ci-failure.py prompt --scan`, `bindToCurrentThread:
   true` and `schedule: {type: "interval", everyMs: 900000}`. Binding it to the
   dispatcher thread makes the webhook and the scan one owner whose runs never
   overlap. Approving this step grants the worker authority above.
5. Update the webhook task's prompt to the current
   `python3 scripts/main-ci-failure.py prompt` with `schedule_task` and its
   `scheduledTaskId`, passing only `prompt`.

## Readback

- `list_scheduled_tasks` shows both tasks enabled and bound to the dispatcher
  thread: the webhook one with a signature, the scan one every 15 minutes.
- `gh secret list --repo MaudeCode/talaria` lists both `MAIN_CI_WEBHOOK_*` names.
- Controlled handoff: post a body with a wrong signature and confirm T3 starts
  no run. Then post a correctly signed body for a past failed `main` run that a
  later green run superseded, and confirm the dispatcher replies with a
  `noop … superseded` line and launches nothing. A launch proof uses a failure
  the owner selects; confirm the repair thread opens in its own worktree.
- Measure each lane from GitHub and T3 timestamps: the failed job's
  `completed_at`, the repair thread's `createdAt`, the worker's reproduction
  result on the ticket, the repair PR's `created_at`, and `land`'s merge
  readback.

## Failure recovery

The `alert` job never changes the CI Gate. When it fails, its error names the cause:

- **Set the MAIN_CI_WEBHOOK_URL and MAIN_CI_WEBHOOK_SECRET Actions secrets**:
  setup step 3 is missing.
- **HTTP 401**: the secrets disagree. Rotate the signing secret in the task
  and in `MAIN_CI_WEBHOOK_SECRET` together.
- **HTTP 403**: the receiver's edge refused the request before T3 checked its
  signature (Cloudflare error 1010 for a blocked User-Agent). The sender
  identifies itself as `talaria-ci-failure-handoff`; Python's default
  `Python-urllib/*` agent is refused.
- **HTTP 404**: the task or its URL changed; update `MAIN_CI_WEBHOOK_URL`.
- **HTTP 5xx, 429 or delivery failed after 3 attempts**: T3 or T3 Connect was
  unreachable. Re-run just the alert job with `gh run rerun <run ID> --job <job ID> --repo MaudeCode/talaria`.

A dispatcher reply of `noop … an operator decides` means two repair launches
for that incident ended without finishing; read those threads before starting
another by hand. Disable both scheduled tasks to stop all handoffs.
