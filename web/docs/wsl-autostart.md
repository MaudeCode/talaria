# Windows / WSL auto-start

Talaria Web runs well under WSL2, but Windows login does not start Linux user
processes. This guide installs a small launcher script inside WSL and runs it
either when a WSL shell opens or at Windows logon.

It assumes a global npm install inside WSL (`npm install -g
@maudecode/talaria-web`), so `talaria-web` is on `PATH`.

## The launcher script

Save this as `~/.local/bin/talaria-web-autostart` inside WSL and make it
executable (`chmod +x ~/.local/bin/talaria-web-autostart`):

```bash
#!/usr/bin/env bash
# Start Talaria Web once: a lock, a /health check, and a pid file prevent duplicates.
set -euo pipefail

PORT="${HERMES_WEBUI_PORT:-8787}"
LOG_DIR="${HERMES_WEBUI_LOG_DIR:-$HOME/.hermes/webui/logs}"
PID_FILE="$LOG_DIR/talaria-web.pid"
LOG="$LOG_DIR/talaria-web.log"
export HERMES_WEBUI_HOST="${HERMES_WEBUI_HOST:-127.0.0.1}" HERMES_WEBUI_PORT="$PORT"
# Lets the server size-bound the log it writes to.
export HERMES_WEBUI_LOG_FILE="$LOG"

mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
note() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG_DIR/autostart.log"; }
healthy() {
  local scheme=http
  [[ -n "${HERMES_WEBUI_TLS_CERT:-}" && -n "${HERMES_WEBUI_TLS_KEY:-}" ]] && scheme=https
  curl -fsSk --max-time 3 "$scheme://127.0.0.1:$PORT/health" >/dev/null 2>&1
}
alive() { [[ -s "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

exec 9>"/tmp/talaria-web-autostart.lock"
flock -n 9 || { note "another autostart holds the lock"; exit 0; }
if healthy || alive; then note "already running"; exit 0; fi

note "starting talaria-web on port $PORT"
nohup talaria-web --foreground --no-browser >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"
sleep 2
if healthy || alive; then note "started (pid $(cat "$PID_FILE"))"; exit 0; fi
note "talaria-web exited; see $LOG"
exit 1
```

It honours these variables:

| Variable | Default | Purpose |
|---|---|---|
| `HERMES_WEBUI_HOST` | `127.0.0.1` | Bind address passed to `talaria-web` |
| `HERMES_WEBUI_PORT` | `8787` | Server and health-check port |
| `HERMES_WEBUI_LOG_DIR` | `$HOME/.hermes/webui/logs` | `autostart.log`, `talaria-web.log`, and the pid file |
| `HERMES_WEBUI_TLS_CERT`, `HERMES_WEBUI_TLS_KEY` | unset | When both are set, the health check uses HTTPS |

Run it once by hand to check it:

```bash
~/.local/bin/talaria-web-autostart
curl -fsS http://127.0.0.1:8787/health
```

## Option 1: WSL session startup

Starts Talaria Web when your WSL login shell starts. Add this to `~/.profile`
or `~/.bashrc` inside WSL:

```bash
if [ -x "$HOME/.local/bin/talaria-web-autostart" ]; then
  "$HOME/.local/bin/talaria-web-autostart" >/dev/null 2>&1 &
fi
```

Opening several WSL terminals still starts one server: the lock, health check,
and pid file all converge on "already running".

## Option 2: Windows Task Scheduler startup

Starts Talaria Web at Windows logon, before you open a WSL terminal. From a
non-elevated Windows PowerShell (adjust the distro and user):

```powershell
$action  = New-ScheduledTaskAction -Execute "wsl.exe" -Argument '-d Ubuntu -- bash -lc ~/.local/bin/talaria-web-autostart'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName TalariaWebAutoStart -Action $action -Trigger $trigger -RunLevel Limited -Force
```

- Omit `-d Ubuntu` to use your default WSL distro.
- `bash -lc` loads your login profile, so the npm global `bin` is on `PATH`.
- `-Force` updates an existing task instead of creating a duplicate.
- Native Windows (outside WSL2) is not supported.

To inspect or remove the task:

```powershell
Get-ScheduledTask -TaskName TalariaWebAutoStart
Unregister-ScheduledTask -TaskName TalariaWebAutoStart -Confirm:$false
```

## Troubleshooting

```bash
tail -n 80 "$HOME/.hermes/webui/logs/autostart.log"
tail -n 80 "$HOME/.hermes/webui/logs/talaria-web.log"
```

| Symptom | Likely cause | Fix |
|---|---|---|
| Task exists but the server is not reachable | Wrong distro, or `talaria-web` not on the login `PATH` | Re-register with `-d <distro>`; check `bash -lc 'command -v talaria-web'` |
| Server starts only after opening WSL | You used option 1 | Install the scheduled task |
| Health check fails but the pid exists | Still booting, or a different port | Check `HERMES_WEBUI_PORT` and `talaria-web.log` |

For WSL2 with systemd, `talaria-web ctl` and the `systemd --user` pattern in
[`supervisor.md`](supervisor.md) are an alternative.
