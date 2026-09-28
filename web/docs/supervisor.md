# Running Talaria Web under a process supervisor

Use a process supervisor (launchd, systemd, supervisord, runit, s6) when you
want the Web UI to start at boot, restart on crash, or be managed alongside
other services.

## TL;DR

Pass ``--foreground`` to ``talaria-web``:

```bash
talaria-web --foreground --no-browser
```

Or set ``HERMES_WEBUI_FOREGROUND=1`` in the environment. The Web UI will
auto-detect launchd / systemd / supervisord even without the flag, but being
explicit is safer.

**Important (launchd on macOS):** if the ``dev.kil.talaria.web`` LaunchAgent is enabled, treat launchd as the single source of truth for the Talaria Web lifecycle. Do **not** also run ``talaria-web ctl start`` or ``talaria-web`` against the same state dir/port, or you can create a second Talaria Web instance and trigger port-8787 restart churn. ``talaria-web ctl start`` refuses to start next to a running launchd job with that label; if your plist uses a different label, set ``HERMES_WEBUI_LAUNCHD_LABEL`` to it.

## Why ``--foreground`` matters

Without it, ``talaria-web`` does this:

1. Spawn ``talaria-web serve`` as a detached process
2. Probe ``/health`` until the server is up
3. Exit 0

That works for an interactive shell run (``talaria-web`` returns to your
prompt with the server alive in the background). It is **broken** under any
process supervisor: the supervisor sees its tracked PID exit, marks the job
as completed, and respawns ``talaria-web``. The respawn fails to bind port
8787 (the orphaned server still has it), exits non-zero, supervisor
respawns again — loop.

In foreground mode, ``talaria-web`` does its setup work and then runs the
server in the same process tree: the launcher stays attached as a small
supervisor and the HTTP server runs in one worker child. The supervisor
sees the long-lived process as the original child, ``KeepAlive=true`` /
``Restart=always`` work correctly, and a self-update restarts only the
worker (exit code 75) so the tracked PID never changes.

## launchd (macOS)

``~/Library/LaunchAgents/dev.kil.talaria.web.plist``:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.kil.talaria.web</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/talaria-web</string>
        <string>--foreground</string>
        <string>--no-browser</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/yourname</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/yourname/.hermes/webui/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/yourname/.hermes/webui/launchd-stderr.log</string>
<!-- Both of these are size-bounded by the server itself: it resolves its own
     stdout/stderr descriptors and copy-truncates either file past 32 MiB
     (HERMES_WEBUI_LOG_MAX_BYTES; 0 disables). No newsyslog entry is required,
     though one is harmless. -->

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/yourname</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

Load:

```bash
launchctl load ~/Library/LaunchAgents/dev.kil.talaria.web.plist
launchctl print gui/$(id -u)/dev.kil.talaria.web   # check state
```

Reload after editing the plist:

```bash
launchctl unload ~/Library/LaunchAgents/dev.kil.talaria.web.plist
launchctl load   ~/Library/LaunchAgents/dev.kil.talaria.web.plist
```

launchd sets ``XPC_SERVICE_NAME`` automatically, so even without the
``--foreground`` argument the Web UI will auto-promote to foreground mode.
The flag is still recommended as documentation of intent.

## systemd (Linux)

``~/.config/systemd/user/hermes-webui.service``:

```ini
[Unit]
Description=Talaria Web
After=network.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=/usr/local/bin/talaria-web --foreground --no-browser
Restart=on-failure
RestartSec=5

# Optional: route stdout/stderr to journald instead of files
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Enable + start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now hermes-webui.service
journalctl --user -u hermes-webui.service -f
```

``talaria-web ctl start`` refuses to start next to an active ``hermes-webui.service``
on the same port; set ``HERMES_WEBUI_SYSTEMD_UNIT`` if your unit has another name.

systemd sets ``INVOCATION_ID`` and ``JOURNAL_STREAM`` (when stdio is wired to
the journal), both of which auto-promote to foreground mode.

## supervisord (cross-platform)

``/etc/supervisor/conf.d/talaria-web.conf``:

```ini
[program:talaria-web]
command=/usr/local/bin/talaria-web --foreground --no-browser
directory=/home/youruser
user=youruser
autostart=true
autorestart=true
stopsignal=TERM
stopwaitsecs=10
stdout_logfile=/var/log/talaria-web.out.log
stderr_logfile=/var/log/talaria-web.err.log
environment=HOME="/home/youruser",PATH="/usr/local/bin:/usr/bin:/bin"
```

Reload + start:

```bash
sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl status talaria-web
```

supervisord sets ``SUPERVISOR_ENABLED``, which auto-promotes to foreground
mode.

## Auto-detected env vars (full list)

These trigger ``--foreground`` behavior even when the flag is not passed:

| Env var | Set by | Notes |
|---|---|---|
| ``INVOCATION_ID`` | systemd | Set on every service activation |
| ``JOURNAL_STREAM`` | systemd | Set when stdio is wired to journald |
| ``NOTIFY_SOCKET`` | systemd ``Type=notify`` / s6 | sd_notify-style notification socket |
| ``XPC_SERVICE_NAME`` | launchd | Set to the plist Label — narrowed to ``com.<rdns>.<svc>`` form (see below) |
| ``SUPERVISOR_ENABLED`` | supervisord | Always set under supervisord |
| ``HERMES_WEBUI_FOREGROUND`` | you | Explicit opt-in; accepts ``1`` / ``true`` / ``yes`` / ``on`` |

### XPC_SERVICE_NAME noise filter

macOS launchd sets ``XPC_SERVICE_NAME`` in **every Terminal-spawned shell**,
not just real services. Typical noise values:

- ``0`` — set on launchd descendants generally
- ``application.com.apple.Terminal.<UUID>`` — Terminal.app shells
- ``application.com.googlecode.iterm2`` — iTerm2
- ``application.com.microsoft.VSCode`` — VSCode integrated terminal

A bare existence check on this var would auto-promote interactive
``talaria-web`` runs to foreground mode on every Mac dev machine, breaking
the most common installation path. We narrow detection to launchd
**Label-style** names (typically reverse-DNS like ``com.example.foo``).
Real launchd plists always use this form. If you ever see
``XPC_SERVICE_NAME=0`` in your service environment, the auto-detect will
ignore it — set ``HERMES_WEBUI_FOREGROUND=1`` or pass ``--foreground``
explicitly to be safe.

### Supervisors that are NOT auto-detected

The following set no env var that we can reliably detect. Pass
``--foreground`` (or ``HERMES_WEBUI_FOREGROUND=1``) explicitly:

- **runit** (without sd_notify) — pure runit chains
- **daemontools** / ``svc``
- **PM2**
- **Foreman** / **Honcho** (Procfile-style)
- **Docker** with a custom CMD entrypoint that doesn't already use ``exec``
- **Custom shell-script supervisors** that fork-and-wait

If your supervisor isn't in the auto-detect list and you see the orphan-PID
respawn loop, set ``HERMES_WEBUI_FOREGROUND=1`` in the service environment.

## Diagnostic recipe

If the Web UI keeps getting respawned and you suspect the double-fork loop:

```bash
# Check the running PID for the server
lsof -iTCP:8787 -sTCP:LISTEN

# Get its parent — should be the supervisor itself, NOT init (PID 1)
PID=$(lsof -tiTCP:8787 -sTCP:LISTEN)
ps -p "$PID" -o pid,ppid,cmd
ps -p "$(ps -o ppid= -p "$PID" | tr -d ' ')" -o pid,cmd
```

A healthy foreground-mode setup looks like:

```
PID    PPID  CMD
12346  12345 node .../talaria-web.js serve        # the HTTP server worker
12345  6789  node .../talaria-web.js --foreground # the attached launcher/supervisor
6789   1     /sbin/launchd                         # or /usr/lib/systemd/systemd, etc.
```

If PPID is ``1`` (init) when it should be the supervisor, the orphan-server
loop is happening — re-check that ``--foreground`` (or one of the env vars)
is reaching the process.

## HTTP watchdog / deep health

``KeepAlive`` / ``Restart=always`` only recover a process that exits. If the
process is still listening on the port but request handling is wedged, pair your
supervisor with an HTTP probe and force a restart when the probe fails.

Talaria Web exposes two health levels:

- ``/health`` — cheap liveness probe with ``active_streams``, uptime, and an
  ``accept_loop`` heartbeat counter.
- ``/health?deep=1`` — readiness probe that briefly acquires the stream lock,
  reads the sidebar/session path, reads projects state, and touches Hermes
  ``state.db`` if it exists. Use this for watchdogs.

Minimal macOS launchd watchdog script:

```bash
#!/usr/bin/env bash
set -euo pipefail
LABEL="dev.kil.talaria.web"
BASE="http://127.0.0.1:8787"

if ! curl -fsS --max-time 10 "$BASE/health?deep=1" >/dev/null; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
fi
```

Run it every few minutes from a separate ``StartInterval`` LaunchAgent. For
systemd, prefer a timer/service pair that runs the same curl probe and
``systemctl --user restart hermes-webui.service`` on failure.

The ``accept_loop.requests_total`` value should increase when probes arrive. If
it stays flat while the process is still alive, the server accept loop is not
making progress; capture logs/thread samples before restarting if you are
collecting diagnostics for a bug report.
