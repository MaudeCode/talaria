# Windows / WSL auto-start

Talaria Web runs well under WSL2, but native Windows login does not automatically start Linux user processes. This guide covers two supported options:

1. **WSL session startup** — simple and low-risk. WebUI starts the next time you open a WSL shell.
2. **Windows Task Scheduler** — true Windows logon startup. Windows invokes `wsl.exe`, which runs the WSL launch script.

Both paths use the same WSL launch script:

```text
scripts/wsl/hermes_webui_autostart.sh
```

The script is safe to call repeatedly. It uses a lock file, checks the `/health` endpoint, checks a pid file, and writes logs before starting `talaria-web --foreground --no-browser` in the background. It does not hardcode a user path; by default it derives the repository root from its own location.

## Script settings

The WSL launcher supports these environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `HERMES_WEBUI_REPO` | repo containing the script | Web checkout to start (`web/`); leave unset with a global `npm install -g @maudecode/talaria-web` |
| `HERMES_WEBUI_BIN` | `talaria-web` on `PATH`, else `packages/server/dist/bin/talaria-web.js` in the repo | Launcher to run |
| `HERMES_WEBUI_LOG_DIR` | `$HOME/.hermes/webui/logs` | Autostart and WebUI logs |
| `HERMES_WEBUI_HOST` | `127.0.0.1` | Host passed through to `talaria-web` |
| `HERMES_WEBUI_PORT` | `8787` | WebUI port and health-check port |
| `HERMES_WEBUI_HEALTH_URL` | `http://127.0.0.1:$HERMES_WEBUI_PORT/health` | URL used to decide whether WebUI is already running |
| `HERMES_WEBUI_PID_FILE` | `$HERMES_WEBUI_LOG_DIR/hermes-webui.pid` | pid file used for duplicate prevention |
| `HERMES_WEBUI_REQUIRE_AGENT_PROCESS` | `0` | Optional: set to `1` only if your local setup requires a separate Hermes process before WebUI starts |

Make the script executable once inside WSL:

```bash
cd /path/to/talaria/web
chmod +x scripts/wsl/hermes_webui_autostart.sh
```

Run it manually to verify your paths and logs:

```bash
scripts/wsl/hermes_webui_autostart.sh
curl -fsS http://127.0.0.1:8787/health
```

Logs are written to:

```text
$HOME/.hermes/webui/logs/webui_autostart.log
$HOME/.hermes/webui/logs/hermes_webui.log
```

## Option 1: WSL session startup

This starts WebUI when your WSL login shell starts. It is the easiest option if you already open WSL during your day.

Add this to `~/.profile` or `~/.bashrc` inside WSL, adjusting the repo path:

```bash
if [ -x "$HOME/talaria/web/scripts/wsl/hermes_webui_autostart.sh" ]; then
  HERMES_WEBUI_REPO="$HOME/talaria/web" \
    "$HOME/talaria/web/scripts/wsl/hermes_webui_autostart.sh" >/dev/null 2>&1 &
fi
```

Open a new WSL terminal and check:

```bash
curl -fsS http://127.0.0.1:8787/health
```

If you open several WSL terminals, the launcher should still start only one WebUI process because the lock, health check, and pid file all converge on "already running".

## Option 2: Windows Task Scheduler startup

Use this if you want WebUI to start automatically at Windows logon even before you open a WSL terminal.

Register a logon task that runs the WSL launch script through `wsl.exe`. From an
elevated-free Windows PowerShell (adjust the distro and path):

```powershell
$action  = New-ScheduledTaskAction -Execute "wsl.exe" -Argument '-d Ubuntu -- /home/your-user/talaria/web/scripts/wsl/hermes_webui_autostart.sh'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName HermesWebUIAutoStart -Action $action -Trigger $trigger -RunLevel Limited -Force
```

Notes:

- Omit `-d Ubuntu` to use your default WSL distro.
- `-Force` updates an existing task instead of creating duplicates.
- The task runs as the current Windows user at logon with least privilege.
- Native Windows (outside WSL2) is not supported.

To inspect or remove the task later:

```powershell
Get-ScheduledTask -TaskName HermesWebUIAutoStart
Unregister-ScheduledTask -TaskName HermesWebUIAutoStart -Confirm:$false
```

## Troubleshooting

Check the WSL logs first:

```bash
tail -n 80 "$HOME/.hermes/webui/logs/webui_autostart.log"
tail -n 80 "$HOME/.hermes/webui/logs/hermes_webui.log"
```

Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| Task exists but WebUI is not reachable | WSL script path is wrong for the selected distro | Re-register the task with the correct script path and `-d <distro>` |
| WebUI starts only after opening WSL | You used the WSL session startup option, not Task Scheduler | Install the Windows scheduled task |
| Multiple login events happen quickly | Normal Windows startup behavior | The WSL script should log `already running` and avoid duplicate processes |
| Health check fails but pid exists | WebUI is still booting or the port differs | Check `HERMES_WEBUI_PORT` and `hermes_webui.log` |

If you want WSL2 systemd integration instead, see `docs/supervisor.md` for foreground process-supervisor guidance and adapt the Linux `systemd --user` pattern to your distro.
