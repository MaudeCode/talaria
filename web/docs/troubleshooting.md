# Troubleshooting

Concrete diagnostic flows for the most common failure modes when running Hermes WebUI. Each entry has the symptom, the diagnostic commands to run first, and the fix that has worked before.

If your symptom isn't listed and the diagnostics don't narrow it down, keep the relevant command output, redacting secrets, private paths, full `.env` files, full `auth.json` files, cookies, tokens, and password hashes.

---

## "Failed to load session" or "Could not load conversations" after an update

**Symptom.** Session navigation or the conversation sidebar fails, but a browser
reload immediately restores it.

**Why it happens.** A long-lived tab can keep an older JavaScript bundle after
the WebUI server restarts on a newer commit. The old client may issue obsolete or
duplicated session requests until it is refreshed. Embedded Hermes Agent debug
floods can also delay otherwise successful session endpoints long enough for a
reverse proxy or browser request to give up first.

**Current behavior.** The WebUI compares its stamped browser-bundle version with
the server version. When they differ, a visible tab with an empty composer clears
its shell cache and reloads once automatically. Tabs containing unsent composer
text or queued attachments keep the version-mismatch banner and require an
explicit **Hard refresh now**, so an update cannot discard in-progress input.
The per-version retry marker prevents automatic reload loops. The server also
suppresses embedded LSP DEBUG records while retaining INFO, WARNING, and ERROR
diagnostics.

If the problem survives a hard refresh, inspect `/health`, the request-duration
entries in the WebUI log, and the browser Network panel. A session endpoint that
eventually logs HTTP 200 after several seconds usually indicates backend
contention rather than a missing session.

---

## "Hermes Agent sidecar is not running" (HTTP 503, `condition: sidecar_unavailable`)

**Symptom.** The UI loads, but chat, profiles, skills, crons, kanban, and other Agent-backed
routes answer `503` with `{"condition": "sidecar_unavailable"}` (or `agent_incompatible` /
`agent_runtime_stale`). The server log shows `[sidecar] Hermes Agent not found` or a handshake failure.

**Why it happens.** The TypeScript server never imports Agent code. It spawns one Python sidecar,
`python -m talaria_sidecar`, on the Agent's own venv and talks to it over stdio. If no Agent checkout is
found, the venv is missing, or the sidecar cannot import `run_agent`, the server keeps serving the UI and
fails those routes closed. Common causes:

1. **No Agent checkout in a discovered location.** Discovery tries `HERMES_WEBUI_AGENT_DIR`,
   `$HERMES_HOME/hermes-agent`, a sibling `hermes-agent` checkout, `~/hermes-agent`, `/opt/hermes`,
   `/usr/local/lib/hermes-agent`, and the `hermes` launcher on `PATH`.
2. **Checkout without a venv.** The sidecar runs on `<agent>/venv` or `<agent>/.venv`; `HERMES_WEBUI_PYTHON`
   overrides the interpreter.
3. **`HERMES_WEBUI_AGENT_DIR` pointing at the wrong directory.** The override beats discovery.
4. **Agent revision drift.** The handshake compares the loaded Agent with `sidecar/agent_dependency.json`;
   `agent_incompatible` means the checkout is not the tested revision, `agent_runtime_stale` means the
   checkout changed while the server was running.

### Step 1 — read what the launcher resolved

```bash
talaria-web --foreground --no-browser 2>&1 | grep -iE 'sidecar|agent' | head -20
```

The startup lines print the Agent directory and interpreter the sidecar was started on, or the list of
locations that were probed.

### Step 2 — point at the right checkout and venv

```bash
export HERMES_WEBUI_AGENT_DIR=/absolute/path/to/hermes-agent
export HERMES_WEBUI_PYTHON=/absolute/path/to/hermes-agent/venv/bin/python
talaria-web ctl restart
```

### Step 3 — verify the sidecar can import the Agent

```bash
cd /path/to/talaria/web
HERMES_WEBUI_AGENT_DIR=/absolute/path/to/hermes-agent sidecar/scripts/test.sh tests/test_runtime.py
```

The runtime tests spawn the sidecar exactly as the server does and report the import error verbatim.
`/api/health/agent` and `/health` also carry the sidecar status once the server is up.

### When it's a Web bug

If the sidecar tests pass but the server still answers `sidecar_unavailable`, that is a Web bug. Its evidence
is the startup lines from step 1, the `/health` payload, and your OS, Node, and Agent versions.

---

## "Response interrupted." marker keeps saying "no agent output was recovered"

**Symptom.** After a live response stream stops before a turn completes (manual restart, OOM, crash, browser/SSE disconnect, lost worker bookkeeping, …), the affected chat shows an `**Response interrupted.**` marker. If the run-journal for that turn is already visible on disk, the marker says the partial output was recovered; if not, it preserves the user turn and says no agent output was recovered yet.

**Why.** Sidecar repair re-checks the run-journal after it detects a stale stream and uses the result as a one-shot signal. On WSL2 (9p / DrvFs) and on some network-backed setups, the run-journal `.jsonl` is written by the stopped worker but the WebUI process reads it through a page-cache state that has not yet seen those writes — recovery returns "empty" and the marker would otherwise be baked permanently. The fix introduces a *lazy* retry path: when sidecar repair cannot read visible output but knows the stream id, it stores a `_pending_journal_recovery` flag on the marker and re-attempts recovery from `get_session()` until the journal becomes readable (or the retry budget is exhausted).

**Interruption classes.** The WebUI now keeps the user-facing cases separate instead of implying every stale stream was a restart:

- **Browser/SSE connection interrupted** — the live browser `EventSource` transport dropped. The UI reports `Connection interrupted` and tries status/replay/session restore before showing the final browser-side notice. Chat and gateway SSE errors also POST a small sanitized diagnostic event to `/api/client-events/log` (source, session id, stream id, readyState, visibility, online state, path without query string) so server logs can distinguish browser transport loss from backend worker loss.
- **Lost worker bookkeeping** — the stream id is gone and the worker registry no longer has an active run. Recovery markers carry `interruption_cause: "lost_worker_bookkeeping"` and `/api/chat/stream/status` reports `terminal_state: "lost-worker-bookkeeping"` for non-terminal journals that are no longer active.
- **Stream/run split-brain** — the stream is gone but `ACTIVE_RUNS` still lists the worker. Recovery markers carry `interruption_cause: "stream_run_split_brain"` so the transcript says this is a bookkeeping split-brain rather than a restart.
- **Process crash/restart** — `SERVER_START_TIME` is newer than `pending_started_at`, meaning the WebUI process started after the turn began. Recovery markers carry `interruption_cause: "process_restart"` and explicitly say the process-start evidence points to a crash or restart.

**Diagnostic.**

The on-disk locations below assume the default `~/.hermes/webui` state directory. If you override it via `HERMES_WEBUI_STATE_DIR`, substitute that path for `~/.hermes/webui` in every step.

1. Identify the affected session id and stream id from the marker. The marker JSON lives at `~/.hermes/webui/sessions/<sid>.json`; after the fix it shows them on the `_journal_retry_stream_id` key. Pre-fix sessions only carry the legacy wording, with no retry meta.
2. Check whether the run-journal contains real events:
   ```bash
   ls -la ~/.hermes/webui/sessions/_run_journal/<sid>/<stream_id>.jsonl
   head -2 ~/.hermes/webui/sessions/_run_journal/<sid>/<stream_id>.jsonl
   ```
   If the file exists and contains `token` / `tool` events, the lazy-retry path will pick them up the next time the session is opened.

**Fix.** Reload the session in the browser. On the next `get_session()` call the marker is re-evaluated; if the journaled events are visible on disk the marker promotes to *"The partial output above was recovered from the run journal …"* wording and the journaled assistant text + tool cards land above the marker in chronological order. No manual sidecar editing is required.

Recovery is incremental: the marker records how far into the journal it has replayed (`_journal_retry_after_seq`), so a journal that keeps surfacing in waves, or one larger than a single 8 MiB read, is appended one fragment at a time rather than replayed from the start. While the journal has no terminal row the marker stays armed with that cursor; a `done` row above recovered output removes the marker, and a `cancel` or error row settles it.

**Trigger.** Sidebar metadata polling is intentionally not enough to run this self-heal. Requests such as `/api/session?messages=0&resolve_model=0` load the session with `metadata_only=True`, skip the full messages array, and therefore skip the lazy journal retry helper. Click/open the affected conversation so the message panel performs a full `messages=1` load; that full render is what re-checks the journal and can promote the marker.

**Caps.** The lazy retry path gives up after 12 failed attempts or 24h of wall-clock age, at which point the marker settles: it keeps the recovered-output wording if earlier passes placed output, and otherwise demotes to a neutral *"Partial output may have been lost."* wording so the "reload to retry" prompt doesn't linger forever for genuinely lost journals.

**When it's a bug.** If, after the fix, you see the lazy-retry wording (*"Recovering the partial output from the run journal — reload this session to retry."*) but reloading the session never promotes it to the recovered wording even though the `.jsonl` clearly contains `token` events, that is a bug; its evidence is the marker JSON and the run-journal file.

---

## Run-journal storage keeps growing

Completed runs retain their full replay journal for 14 days by default. WebUI
also keeps at least the three newest terminal journals per session regardless of
age, and never prunes a journal whose last event is nonterminal. Retention runs
in a background thread at startup and is coalesced to at most once every six
hours after terminal events.

Before removing an expired full journal, WebUI atomically writes a compact
`<run_id>.summary.json` beside it. Status lookups remain auditable from that
summary. A reconnect cursor aimed at a pruned journal returns `cursor_pruned`,
which tells the caller to reload the settled transcript rather than replay stale
events.

The policy can be adjusted with:

- `HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS`, default `14`; set `0` to disable
  retention.
- `HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT`, default `3`; the minimum number of
  terminal journals preserved per session.

Changing these values does not affect active/nonterminal run recovery.

Retention also runs from the SessionChannel reaper thread, at most once every
six hours. Before that it fired only after a terminal run event, so a server
left idle with a large journal directory never reclaimed anything.

---

## The `bootstrap-<port>.log` file keeps growing

The launcher redirects the detached server's stdout and stderr to `<state dir>/bootstrap-<port>.log`; `talaria-web ctl` writes to `webui.log` under the Hermes home instead (override with an absolute `HERMES_WEBUI_LOG_FILE`). Neither file rotates: truncate or rotate it with your usual tooling (logrotate, `truncate -s 0`), which is safe while the server runs.

## "Context compression exhausted" after a long-running turn

**Symptom.** A long-running session, often with many tool calls or a small
context-window model, ends with a `Context compression exhausted` error instead
of a final answer. The message includes a recovery action labeled `Start focused
continuation`.

**Why.** Automatic compression could not shrink the current conversation enough
to continue safely in the same model-facing context. The exhausted session is
terminal: sending a bare "continue", "go on", or "继续" would usually replay the
same oversized state and fail again, so the WebUI points the user to a focused
linked continuation instead.

**Diagnostic.**

1. Open the session JSON under your WebUI state directory, for example:
   ```bash
   jq '.recommended_recovery_action, .compression_recovery' \
     ~/.hermes/webui/sessions/<session_id>.json
   ```
2. A recoverable exhausted turn should report:
   - `recommended_recovery_action: "start_focused_continuation"`
   - `compression_recovery.terminal_state: "compression_exhausted"`
   - the final assistant error message carrying `_compressionRecovery`

**Fix.** Use the `Start focused continuation` action in the exhausted message.
The new linked session preserves the workspace, model, profile, project, and
toolset lane, but intentionally starts with an empty model-facing transcript so
the oversized exhausted tail is not replayed. After the new session opens,
describe the next narrow task explicitly instead of sending a bare continuation.

**When it's a bug.** It is a bug if the exhausted message has no recovery
action, the action creates a session with the old oversized context/messages
replayed into the model-facing transcript, or a bare "continue" starts another
turn in the exhausted session instead of being blocked with recovery guidance.

---

## Installed PWA opens to a blank screen after an update

**Symptom.** The installed PWA or home-screen app opens to a blank screen after a WebUI update, while the same URL often works again in a normal browser tab.

**Why.** Reverse proxies are supported, but proxy basic auth can challenge the same-origin `sw.js`, manifest, or versioned `static/*` fetches the installed app needs while its service worker updates the shell.

**Diagnostic.**

1. Open the same WebUI URL in a regular browser tab and confirm whether it loads there.
2. Check reverse-proxy logs for `401` responses on `/sw.js`, `/manifest.json`, or versioned `/static/*` assets during the update.
3. Temporarily remove proxy basic auth and use WebUI's built-in password. If the blank screen stops after the next update, the proxy auth challenge was the trigger.

**Fix.** Prefer WebUI's own password for installed PWAs. If you keep proxy basic auth, configure it so the same-origin service-worker and shell update fetches can complete. If the installed shell is already blank, clear site data for the Hermes origin, then reopen or reinstall the PWA after that site-scoped cleanup.

**When it's a bug.** It is a WebUI bug if the blank screen still reproduces without proxy basic auth, or after the proxy allows the same-origin service-worker and shell update fetches through.

---

## "Hermes Agent was updated while Hermes WebUI was running"

**Symptom.** An action that uses the in-process Agent runtime stops with a message telling you to restart Hermes WebUI manually. This can happen after `hermes update`, a Git checkout/pull in the Agent source tree, or another tool updates Hermes Agent without restarting the already-running WebUI backend.

**Why.** The sidecar imports `run_agent.AIAgent` into its long-lived Python process. Continuing after a known Agent Git revision changes could combine cached modules from the old revision with source read from the new revision. Local Agent-backed actions return a retryable `409 agent_runtime_stale` with `restart_scheduled: false` before accepting a new turn. Gateway- and runner-owned chat keep their existing runtime ownership. Non-Git Agent installs preserve their existing behavior because there is no revision identity to compare; losing a previously known revision remains fail-closed.

**Diagnostic.** The stale-runtime response includes `agent_update_state`, also preserved in asynchronous compression error status:

| Value | Observation |
| --- | --- |
| `active` | A recent Agent update marker names a live PID. |
| `incomplete` | An Agent recovery marker exists in the loaded checkout or configured venv installation. |
| `stale` | The update marker names a dead PID or is older than the diagnostic age limit. |
| `unknown` | Marker contents, PID liveness, or recovery-marker presence cannot be read or classified. |
| `unverified` | No active or recovery marker was found. Update completion and environment health remain unverified. |

These are observations, not success receipts. Hermes Agent removes `.hermes-update-in-progress` on failed and interrupted exits too. A missing or stale marker, or a readable Git revision, does not prove a completed update or a healthy environment. WebUI only reads these markers; it does not remove or repair them.

**Fix.** Check the Agent updater's outcome and resolve any failed or incomplete Agent update first. Once the Agent checkout and environment are healthy and no updater is running, restart WebUI using the same launch method that started it:

```bash
talaria-web ctl restart
# Or, for a user systemd service:
systemctl --user restart hermes-webui.service
```

For a foreground `talaria-web --foreground`, stop it with Ctrl-C and start it again. Restarting the whole computer or WSL is not required when restarting the WebUI backend succeeds. Retry the action after restarting the backend; refreshing the browser alone does not replace its imported Agent modules.

**Automatic restart prerequisite.** Revision mismatch does not schedule a WebUI restart. Safe automation requires an Agent-owned terminal success receipt bound to the exact update transaction, final revision, and healthy environment, plus an Agent-owned atomic handoff or lease that excludes new mutations across process replacement (or an Agent updater that performs the restart itself). No such public contract is verified for this integration. Repeated readiness checks followed by a process replacement leave a race; WebUI's own update lock does not exclude an external Agent updater. Explicit updates initiated through WebUI retain their existing behavior and are outside this revision-mismatch guard.

**When it's a bug.** It is a WebUI bug if the restart-required message appears even though the Agent revision did not change or become unreadable, or if a clean WebUI restart still produces the same import error. Its evidence is the launch method, WebUI and Agent revisions, the marker diagnostic, and sanitized error text.

An installed Agent revision different from the Web release's tested pin now produces an unsupported-version
warning, not a blanket refusal. If Agent imports fail, the sidecar can still read and write operator config;
SSO can use a readable config. A sidecar or RPC transport failure, unreadable or invalid YAML, or a genuinely
missing Agent capability still fails closed. Check the sidecar status and the specific failing operation before
changing the Agent checkout.

---

## 404 after login when password auth is enabled

**Symptom.** After enabling password authentication (`HERMES_WEBUI_PASSWORD`), logging in redirects to `/sessions` and the browser shows a `404 not found` error instead of the chat interface.

**Why.** The server-side redirect after login targets `/sessions` (plural), but that path was missing from the explicit SPA-shell allowlist in `handle_get()`. Without auth the bug is invisible because the SPA handles `/sessions` client-side and the server route is never hit — only the server-side post-login redirect exposes it.

**Fix.** `/sessions` is now included alongside `/` and `/index.html` in the set of paths that serve the SPA shell. No configuration change is needed.

---

## Other troubleshooting

This document grows over time. Each entry follows **Symptom → Why → Diagnostic commands → Fix → When it's a bug**.

Related references:

- [`docs/supervisor.md`](supervisor.md) — process-supervisor setup (launchd, systemd, supervisord, runit/s6) including the bootstrap supervisor-foreground flag.
- [`docs/docker.md`](docker.md) — Docker compose setup, common failure modes, bind-mount migration.
- [`docs/wsl-autostart.md`](wsl-autostart.md) — WSL2 auto-start at login on Windows.
- [`docs/EXTENSIONS.md`](EXTENSIONS.md) — WebUI extension injection, security model, examples.
