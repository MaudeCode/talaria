# Scheduled jobs (the Tasks panel)

The **Tasks** panel creates and edits the agent's cron jobs. A job is a schedule
plus a payload: a prompt the agent runs, a script the scheduler runs, or both.
This page covers the job controls, and in particular the **Advanced** section,
whose options interact with each other in ways the form hints only summarize.

Jobs are stored by Hermes Agent, not the WebUI, and run in the agent's
scheduler. The WebUI is one of three front ends for the same job records — the
others are `hermes cron ...` on the CLI and the agent's own `cronjob` tool — so
a job created here is editable from any of them.

## The primary fields

| Field | Meaning |
| --- | --- |
| **Name** | Optional label. Defaults to the start of the prompt. |
| **Schedule** | A preset (hourly/daily/weekdays/weekly/monthly) or a raw cron expression. Duration forms like `30m` run **once** and then delete the job; use `every 30m` for a recurring one. Times are server time. |
| **Prompt** | What the agent runs. It must be self-contained — a job runs in a fresh session with no chat history. |
| **Deliver output to** | Where the output is posted. `Local` saves it without delivering. |
| **Profile** | Which agent profile the job runs under. |
| **Model** | Pin a provider/model, or leave on Default to follow the profile at run time. |
| **Completion toasts** | Whether finishing this job raises a toast in the WebUI. |
| **Skills** | Skills loaded before the prompt. Fixed at creation. |

## Advanced

The section opens automatically whenever a job already has one of these set.

### Script path

A script run on every tick. Relative paths resolve under `~/.hermes/scripts/`;
`.sh` and `.bash` run via bash, anything else via Python.

Its role depends on **Script-only**:

- **Off** (an agent job) — the script runs first and its stdout is injected into
  the prompt as context. Use it to collect data the prompt then reasons about.
- **On** (a script-only job) — the script *is* the job.

### Script-only job

Runs the script on schedule and delivers its stdout verbatim, with no LLM call.
Empty stdout delivers nothing, which is the classic watchdog pattern: the job
stays silent until something is wrong.

Constraints:

- A script-only job **requires** a script path.
- It **cannot** have a monitor source (see below).
- Prompt, skills, and reasoning effort do not apply — there is no agent run to
  configure. The form keeps the values you entered, so turning Script-only back
  off restores them.

### Monitor source

A cheap change-detector that gates the agent: either an `http(s)://` URL fetched
each tick, or a script path (same resolution rules as **Script path**) run each
tick.

Each tick the source's output is compared to the previous tick's:

- **Identical** — the agent run is skipped entirely. No tokens are spent.
- **Changed** — the agent runs, with a diff of what changed injected into the
  prompt.
- **First tick** — always runs, to establish the baseline.

The output must be deterministic. A source that embeds a timestamp looks changed
on every tick and the monitor saves nothing.

A monitor cannot be combined with **Script-only**: the whole point of a monitor
is to wake or suppress an agent, and a script-only job has no agent to gate. The
form blocks the save rather than silently dropping one of the two — clear the
monitor first, or leave Script-only off.

### Continuity

Each run sees this job's own previous output, so it can skip what it already
reported and continue where it left off. Use it for scouts, monitors, and
incremental digests, where repeating yesterday's findings is the failure mode.

### Context from jobs

Injects the most recent output of the selected jobs as context on every run.
This chains jobs: job A collects, job B processes what A found.

Only jobs in the active profile can be chained. Jobs shown from other profiles
(with **Show all profiles** on) are not offered here, because their IDs do not
resolve in the profile the job will run under.

For a job's *own* previous output, use **Continuity** rather than selecting
itself.

### Reasoning effort

Pins this job to one reasoning level, overriding both the global setting and any
per-model override at run time. Levels above what the resolved model supports
are clamped or dropped by the provider, exactly as they are for the global
setting.

Leave it on Default unless the job specifically needs more or less deliberation
than the profile's default.

### Repeat count

How many times the job runs before it retires. Blank keeps the default: once for
a one-shot schedule, forever for a recurring one.

This is **set at creation only**. Once a job exists the scheduler tracks its
repeat state as a limit plus a completed count, so the form does not offer it on
edit — changing the limit of a running job is a `hermes cron` operation.
Duplicating a job does carry its limit over.

## Clearing a value

On edit, emptying a field clears it: an empty script path or monitor source
removes it, deselecting every chained job clears the chain, and unchecking
Continuity turns it off. Leaving a field untouched leaves it as it was.
