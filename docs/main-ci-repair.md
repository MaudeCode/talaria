# CI repair handoff

When `main` or a release goes red, GitHub starts one T3 repair session, and
that session repairs what failed, merges the repairs and closes, without an
operator, Factory, a scheduler job or a ticket claim (TAL-2397, TAL-2460). A
pull request's failures belong to the agent that opened it and never start one.

## When a session starts

A red run sends its report only when all of these hold. The decision runs in
the run's own `Hand the failure to T3` job (`scripts/main-ci-failure.py send`),
before any session exists:

- The run is a push run of `main`'s CI or a release run on `main`.
- A test or step failed that is not only a runner fault (setting up, installing,
  booting or waiting for the simulator, a lost runner) or a release's build or
  publication job.
- For `main`, no newer `main` run passed, unless a rerun of this commit passed
  the failed job (that is an intermittent failure, never a fix).
- No repair is in progress for the lane: no open issue carrying
  `ci-repair-lock: main` (or `release`).
- At least one failure has no open needs-a-person issue carrying
  `ci-repair-known: <key>` for it.

Otherwise nothing is sent, and the job's summary says why. Only issues a
collaborator opened count, so nobody outside the repository can silence or
start a repair. Nothing polls: a report that is lost is lost.

A newer push to `main` cancels the `main` CI run it supersedes, and a cancelled
run sends nothing. The newer run tests every change since the last `main` run
that completed (passed or failed), or every suite when none did. Its `Detect
changed paths` job records that range in a `Tested range` notice, and the
session's brief names it as a compare link: the failure is in one of those
commits (TAL-2461).

## The repair session

The webhook task starts a new thread for each report it accepts
(`bindToCurrentThread: false`), and its prompt
(`python3 scripts/main-ci-failure.py prompt`) is the session's whole lifecycle:

1. Validate the run ID, fetch `origin/main`, and run `triage` from `main`'s copy
   of the script. It asks the sender's question again and answers `work` or
   `stop`; on `stop` the session replies one line and settles.
2. `claim` the lane: open the `ci-repair-lock: <lane>` issue, then read the
   lane's claims again. The oldest claim wins, so of two sessions that start
   seconds apart the later one closes its own claim and stops.
3. Make its own worktree from `origin/main` under
   `~/.t3/worktrees/talaria/ci-repair-<run ID>` and work only there. A thread a
   scheduled task starts runs in the project's root checkout, which may hold
   someone else's uncommitted work; the session never edits it.
4. Repair every failure `triage` lists: group them by root cause, reproduce
   each at the failing commit with bounded repetitions, decide the cause from
   evidence, follow the defect loop in [testing.md](testing.md), and open one
   pull request per root cause. Each pull request has its own Kanvil ticket, and
   its body and every commit carry `ci-repair-claim: <claim number>`; every commit
   also carries `ci-repair-branch: <its branch>`.
5. Read its pull requests only through `findings`, wait on them with
   `findings --wait`, and merge each with `land` at the exact head once CI Gate
   passed there.
6. Before it finishes, catch up with what CI left to it while it held the lane:
   the newest finished `main` run, or every release run that finished since its
   claim, repairing whatever new still fails there (`triage --claim` ignores its
   own claim).
7. `park` each failure it cannot repair: a needs-a-person issue carrying
   `ci-repair-known: <key>` with what it found. That failure starts no session
   until a person closes the issue.
8. `release` the claim, remove its worktree, and settle its own thread with
   `t3_thread_organize`, whatever happened.

A session that dies without releasing leaves its claim open, which holds the
lane: close the issue to let the next red run start a session.

`land` merges only the session's own pull request: opened by its `gh` login,
from a `fix/TAL-<number>-<slug>` branch of this repository, whose body carries
its claim line and a regression proof, made only of commits it authored,
committed and signed whose messages carry its claim and branch lines, read for the exact
head it merges, at a head where CI Gate passed. It reads the merge back on
`main`.

### Trust boundary

A repair session holds `gh` and Kanvil credentials with merge rights, so text
someone else wrote must never reach it as instructions. Everything
`scripts/main-ci-failure.py` hands it (`triage`, `claim`, `release`, `park`,
`findings` and `land` output) leaves through `emit()`, which lets a field out
only when `SHAPES` lists it and its value has that field's shape: a commit SHA,
a failure key, a run, job, attempt, step, issue or line number, a test
identifier matching the existing patterns, a job name from the reproduction
table or the workflows' enumerated jobs, or an enumerated lane, fault kind,
route, check status, priority or refusal code. Free text never crosses: the
brief and reasons are the script's own templates filled only with values that
passed `cross()`, and a field `SHAPES` does not list raises.
`test_text_anyone_else_writes_never_reaches_a_repair_session` plants one string
in every record GitHub serves and asserts that it reaches no output.

| Channel | Crosses as |
|---|---|
| The signed report from `main` CI or a release | its run ID (digits) and lane only |
| A `main` push run's or a release run's job, step, annotation and log data | `triage` output through `emit()` |
| Open claim and needs-a-person issues | lanes and failure keys from collaborators' issues, parsed by fixed patterns |
| The session's pull requests: comments, reviews, checks, commits | `findings` through `emit()`: priorities, locations, check runs, foreign commit SHAs |
| A pull request's merge | `land` through `emit()`: refusal codes, the head and the merge commit |

Pull request runs, fork runs, a polling scan and a dispatcher thread no longer
exist, and neither do their guards.

The session treats as trusted, and reads itself: its prompt and `triage`'s
brief; `main`'s source and its own branches; the logs and artifacts of `main`
push and release runs, which ran only code verified on `main`; and `findings`
output with the CI logs of a head `findings` verified as its own signed
commits. It never reads any comment, reply or review text (Codex's included),
pull request notifications, or any issue's or ticket's text. That Kanvil and
issue rule is an instruction rather than a mediated read: the script has no
Kanvil credential, and a narrower tracker capability would need a new
credential this setup does not add.

### Session authority

The setup below grants each repair session exactly this, on this repository:
its claim issue and needs-a-person issues, `fix/TAL-<number>-<slug>` branches,
pull requests to `main`, `@codex review` requests on them, merging them with
`land`, and their Kanvil tickets. It uses the `gh` login and Kanvil connection
T3 already holds; no token, GitHub App or repository setting is added. Branch
protection still requires CI Gate on the merged head, and a flake never
authorizes a release, a deploy or replaying a partial publication.

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
| Senders | the `alert` jobs of `.github/workflows/ci.yml` and `.github/workflows/production-cutover.yml`, each running `scripts/main-ci-failure.py send` |
| Receiver | a T3 webhook scheduled task, one new thread per report, with HMAC verification (`x-hub-signature-256`, hex, `sha256=` prefix) |
| Session prompt | `python3 scripts/main-ci-failure.py prompt` |
| Decisions | `decide()`, asked by `send` and by `triage`, tested by `scripts/test-main-ci-failure.py` |
| Claims | `claim`, `release` and `park`, as GitHub issues |
| The session's reads and merge | `findings` and `land` |
| Secrets | `MAIN_CI_WEBHOOK_URL` and `MAIN_CI_WEBHOOK_SECRET` Actions secrets, read only by the two `alert` jobs |

## Setup (owner-approved)

The webhook task, its signing secret and the two repository secrets exist
(TAL-1103). The one step left after TAL-2460, done from T3 with
`schedule_task` and the task's `scheduledTaskId`:

- `prompt`: the output of `python3 scripts/main-ci-failure.py prompt`;
- `bindToCurrentThread: false`, so each report starts its own thread;
- `schedule`: `{type: "webhook", maxDeliveryAgeMinutes: 720, signature: {header:
  "x-hub-signature-256", encoding: "hex", prefix: "sha256="}, dedupe:
  {replayKey: "{{body.run.id}}-{{body.run.attempt}}", coalesceKey:
  "{{body.lane}}", coalesceWindowSeconds: 600}}`, keeping the stored secret.

`replayKey` drops a second delivery of one run attempt's report; a deliberate
rerun is a new attempt. `coalesceKey` merges one lane's reports that arrive
within ten minutes, which covers the seconds before a session's claim exists.
The old `Main CI repair dispatcher` thread is retired; it stays in the list
until settled by hand.

## Readback

- `list_scheduled_tasks` shows the webhook task enabled, with a signature, the
  dedupe keys, and no bound thread.
- `gh secret list --repo MaudeCode/talaria` lists both `MAIN_CI_WEBHOOK_*` names.
- Controlled handoff: post a body with a wrong signature and confirm T3 starts
  no thread. A launch proof uses a failure the owner selects; confirm the
  session claims the lane, works in its own worktree and settles itself.
- Measure each lane from GitHub and T3 timestamps: the failed job's
  `completed_at`, the session thread's `createdAt`, its claim issue, its pull
  requests' `created_at`, and `land`'s merge readback.

## Failure recovery

An `alert` job never changes its run's result (CI Gate, or the release's). When it fails, its error names the
cause:

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

Close a lane's open claim issue to let its next red run start a session again; disable the
scheduled task to stop all sessions.
