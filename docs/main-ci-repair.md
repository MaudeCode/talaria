# Main CI repair handoff

When a push run of `main`'s CI fails, its `Hand the failure to T3` job posts one
signed failure report to a T3 webhook task. That task's bound dispatcher thread
re-reads the run from GitHub with `scripts/main-ci-failure.py triage` and then
rejects it, records a no-op, updates the active repair thread, or launches one
new top-level repair thread in a worktree from refreshed `main`. The repair
thread files or reuses the Kaneo ticket and delivers the fix through the
software-factory gates. Nothing in this path grants release, deployment, device,
secret, scheduler or repository-administration permissions.

Pull requests build the App and run the package and simulator-hosted unit
tests their diff reaches, repeating the test methods they add or change. A
change the planner cannot bound runs the full hosted suite only with the
`hosted-tests` label, so a hosted-test regression from production code can
still surface here first, on the `main` push that introduced it.

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
| Dispatcher prompt | `python3 scripts/main-ci-failure.py prompt` |
| Decisions | `scripts/main-ci-failure.py triage`, tested by `scripts/test-main-ci-failure.py` |
| Secrets | `MAIN_CI_WEBHOOK_URL` and `MAIN_CI_WEBHOOK_SECRET` Actions secrets, read only by the `alert` job |

Deduplication: repair threads are titled `Repair main CI <head prefix>`. A
delivery for a head that already has a thread updates it; a newer red head
folds into any unfinished repair thread; an open PR whose body carries
`main-ci-incident: <head>` owns the failure; a later green `main` run suppresses
stale reports. An incident gets at most two launches that end failed, cancelled
or rolled back; after that the dispatcher records a no-op for an operator.

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

## Readback

- `list_scheduled_tasks` shows the task enabled, with a webhook schedule, a
  signature, and the dispatcher as its bound thread.
- `gh secret list --repo MaudeCode/talaria` lists both `MAIN_CI_WEBHOOK_*` names.
- Controlled handoff: post a body with a wrong signature and confirm T3 starts
  no run. Then post a correctly signed body for a past failed `main` run that a
  later green run superseded, and confirm the dispatcher replies with a
  `noop … superseded` line and launches nothing. A launch proof uses a failure
  the owner selects; confirm the repair thread opens in its own worktree.

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
for that head ended without finishing; read those threads before starting
another by hand. Disable the scheduled task to stop all handoffs.
