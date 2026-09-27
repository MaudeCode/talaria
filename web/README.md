# Talaria Web

Talaria Web is the browser interface for [Hermes Agent](https://github.com/NousResearch/hermes-agent):
a TypeScript server on Node 24 that serves a React frontend, keeps your sessions and settings, and runs
the Agent through a small Python sidecar on the Agent's own virtual environment. It is one component of
the [Talaria monorepo](../README.md) next to the iOS app and the Relay.

- **Server** — `packages/server`, published as `@maudecode/talaria-web` (bins `talaria-web`, `talaria-web-mcp`).
- **Contracts** — `packages/contracts`, published as `@maudecode/talaria-web-contracts`: every route, SSE
  event, and sidecar RPC method as Zod schemas; the OpenAPI document at `../contracts/web-api.openapi.json`
  is generated from it and consumed by the iOS app.
- **Frontend** — `packages/frontend`, a TanStack Start / React SPA whose production build is committed
  under `static/dist/` so installs need no frontend toolchain.
- **Sidecar** — `sidecar/talaria_sidecar`, stdlib-only Python that wraps the Agent modules (chat turns,
  approvals, profiles, cron, kanban, skills, providers, auxiliary models, STT, `state.db` writes).

Hermes Agent itself is never forked or modified. The sidecar records the Agent revision it was tested against
in `sidecar/agent_dependency.json` and warns when the installed Agent differs. An importable Agent can still run;
individual operations report missing capabilities. Operator config and SSO remain available if Agent imports fail.

## Contents

- [Quick start](#quick-start)
- [Daemon control](#daemon-control)
- [Configuration](#configuration)
- [Docker](#docker)
- [Updates](#updates)
- [MCP server](#mcp-server)
- [Development](#development)
- [Docs](#docs)

## Quick start

Requirements: Node 24 or newer, git, and a Hermes Agent checkout with its venv (the launcher can install
one for you).

```bash
npm install -g @maudecode/talaria-web
talaria-web
```

`talaria-web` loads `.env` (checkout `.env`, then `$HERMES_HOME/.env`), discovers the Agent
(`HERMES_WEBUI_AGENT_DIR`, `$HERMES_HOME/hermes-agent`, a sibling `hermes-agent` checkout, `~/hermes-agent`,
`/opt/hermes`, `/usr/local/lib/hermes-agent`, or the `hermes` launcher on `PATH`), verifies the sidecar can
import the Agent on that venv, offers to install the pinned stable Agent release when none is found
(POSIX; skip with `--skip-agent-install`), starts the server detached, waits for `/health`, prints the
URL, and opens the browser. Under launchd, systemd, supervisord, or with `--foreground`, it stays attached instead.

```text
talaria-web [port] [--host HOST] [--no-browser] [--skip-agent-install] [--foreground]
talaria-web serve [args]                            run the server in this process (supervised worker)
talaria-web ctl <start|stop|restart|status|logs>    daemon control
talaria-web-mcp                                     MCP server over the HTTP API
```

From a source checkout:

```bash
git clone --filter=blob:none --sparse --single-branch https://github.com/MaudeCode/talaria.git talaria
git -C talaria sparse-checkout set web contracts scripts
cd talaria/web
npm ci --workspace packages/contracts --workspace packages/server --include=dev
npm run build --workspace packages/contracts && npm run build --workspace packages/server
node packages/server/dist/bin/talaria-web.js
```

Without an Agent the server still starts: the UI, sessions, files, git, and settings work, while chat and
other Agent-backed routes answer `503` with `condition: sidecar_unavailable` until an Agent is installed.

> **Stopping the server.** `talaria-web ctl start` writes `~/.hermes/webui.pid` and `talaria-web ctl stop`
> stops it. A foreground run stops with Ctrl-C. A detached `talaria-web` run has no PID file: find the
> listener with `lsof -i :8787` (or `ss -tlnp`) and `kill` it.

## Daemon control

```bash
talaria-web ctl start              # background daemon, PID at ~/.hermes/webui.pid
talaria-web ctl status             # PID, uptime, bound host/port, log path, /health
talaria-web ctl logs --lines 100   # tail ~/.hermes/webui.log
talaria-web ctl restart
talaria-web ctl stop
```

`ctl start` refuses to double-start next to a running launchd job or systemd unit for the same port, warns
about a foreign process answering on the port, and respects `.env` plus inline overrides such as
`HERMES_WEBUI_HOST=0.0.0.0 talaria-web ctl start`. In a linked git worktree it keeps PID, log, and state
separate per worktree and picks the first free port from `HERMES_WEBUI_CTL_PORT_START`.

For frontend development against a deployed instance, set `HERMES_WEBUI_DEV_PROXY=http://webui-host:8787`
in `.env` and run `talaria-web ctl start --remote`: it starts only the Vite dev server with hot reload and
proxies API and static requests to that instance. See [docs/supervisor.md](docs/supervisor.md) for
launchd, systemd, and supervisord units and [docs/wsl-autostart.md](docs/wsl-autostart.md) for WSL2.

## Configuration

Everything is optional; discovery fills in what you leave blank. Copy `.env.example` to `.env` for a
commented template.

| Variable | Default | Description |
|---|---|---|
| `HERMES_WEBUI_AGENT_DIR` | auto-discovered | Hermes Agent checkout the sidecar runs against |
| `HERMES_WEBUI_PYTHON` | Agent venv | Interpreter for the sidecar (`<agent>/venv` or `.venv`) |
| `HERMES_WEBUI_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for all IPv4, `::` for all IPv6) |
| `HERMES_WEBUI_PORT` | `8787` | Port |
| `HERMES_HOME` | `~/.hermes` | Hermes state base directory |
| `HERMES_CONFIG_PATH` | `$HERMES_HOME/config.yaml` | Hermes config file; the sidecar reads and writes this exact path (a symlink is updated through its target) |
| `HERMES_WEBUI_STATE_DIR` | `$HERMES_HOME/webui` | Sessions, settings, auth records, journals, shares |
| `HERMES_WEBUI_DEFAULT_WORKSPACE` | `~/workspace` | Default workspace |
| `HERMES_WEBUI_DEFAULT_MODEL` | provider default | Optional model override |
| `HERMES_WEBUI_PASSWORD` | unset | Enables password authentication (required when binding beyond loopback) |
| `HERMES_WEBUI_PASSKEY` | unset | Passkey availability flag |
| `HERMES_WEBUI_TLS_CERT` / `HERMES_WEBUI_TLS_KEY` | unset | Serve HTTPS directly (TLS 1.2+) |
| `HERMES_WEBUI_TRUSTED_PROXY_CIDRS`, `HERMES_WEBUI_TRUST_FORWARDED_FOR`, `HERMES_WEBUI_TRUST_FORWARDED_HOST`, `HERMES_WEBUI_TRUST_FORWARDED_PROTO` | unset | Reverse-proxy trust |
| `HERMES_WEBUI_ALLOWED_ORIGINS` | unset | Extra browser origins accepted by the same-origin check |
| `HERMES_WEBUI_CSP_CONNECT_EXTRA` / `HERMES_WEBUI_CSP_FRAME_EXTRA` | unset | Extra CSP `connect-src` / `frame-src` origins |
| `HERMES_WEBUI_TRUSTED_AUTH_HEADER`, `HERMES_WEBUI_TRUSTED_GROUPS_HEADER`, `HERMES_WEBUI_GROUP_PROFILE_MAP`, `HERMES_WEBUI_TRUSTED_AUTH_LOGOUT_URL` | unset | Trusted-header authentication behind an authenticating proxy |
| `HERMES_WEBUI_OIDC_OWNER_CLAIM` / `HERMES_WEBUI_OIDC_OWNER_VALUES` | unset | OIDC owner policy for operator-only routes |
| `HERMES_WEBUI_SESSION_TTL`, `HERMES_WEBUI_SESSION_SLIDING`, `HERMES_WEBUI_SECURE`, `HERMES_WEBUI_COOKIE_NAME`, `HERMES_WEBUI_PROFILE_COOKIE_NAME` | 30 d, on, auto | Login cookie policy |
| `HERMES_WEBUI_GATEWAY_BASE_URL` / `HERMES_WEBUI_GATEWAY_API_KEY` | `http://127.0.0.1:8642` | Hermes gateway API used by health probes and the gateway chat backend |
| `HERMES_WEBUI_MAX_UPLOAD_MB`, `HERMES_WEBUI_FOLDER_ZIP_MAX_MB`, `HERMES_WEBUI_FOLDER_ZIP_MAX_FILES` | 20, 1024, 50000 | Upload and folder-download limits; the folder archive is plain ZIP32, so the last two are clamped to 4000 MB and 65535 entries |
| `HERMES_WEBUI_MAX_SSE_CLIENTS` | 8 per client | Concurrent stream cap per client identity |
| `HERMES_WEBUI_EXTENSION_DIR`, `HERMES_WEBUI_EXTENSION_MANIFEST` | unset | Local extensions ([docs](docs/EXTENSIONS.md)) |
| `HERMES_WEBUI_EXTERNAL_NOTES_SOURCES` | unset | Notes drawer sources |
| `HERMES_WEBUI_LOG_FILE`, `HERMES_WEBUI_LOG_MAX_BYTES` | detached log, 32 MiB | Size-bounded server log |
| `HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS`, `HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT`, `HERMES_WEBUI_RUN_JOURNAL_FSYNC` | 14, 3, auto | Run journal retention |
| `HERMES_WEBUI_SESSIONS_MAX` | 100 | Session cache size (prefer `webui.sessions_cache_max` in `config.yaml`) |
| `HERMES_WEBUI_FOREGROUND` | auto | Force attached mode (supervisors are auto-detected) |
| `HERMES_WEBUI_PRESERVE_ENV`, `HERMES_WEBUI_NO_DOTENV` | unset | `.env` precedence controls |
| `HERMES_WEBUI_SIDECAR_COMMAND` | unset | Replace the sidecar spawn command (test fixtures only) |
| `TALARIA_RELEASE_TOKEN` | unset | GitHub token with Contents read for private release lookups ([docs](docs/talaria-updates.md)) |

### How chat runs

The sidecar runs `run_agent.AIAgent` in-process on the Agent venv, reading your `HERMES_HOME` config
directly, exactly as the Agent CLI does. Chat never routes through the gateway API (the gateway chat
backend was dropped with TAL-245). To use an external OpenAI-compatible endpoint as a model, add it in
**Settings → Providers**.

### Remote access

Bind to loopback and use an SSH tunnel or Tailscale, or set `HERMES_WEBUI_HOST=0.0.0.0` with
`HERMES_WEBUI_PASSWORD`. See [docs/remote-access.md](docs/remote-access.md).

## Docker

```bash
cd web
cp .env.docker.example .env          # optional; set UID/GID on macOS
docker compose up -d
open http://localhost:8787
```

The image is `ghcr.io/maudecode/talaria-web` (`node:24-slim` plus git, curl, rsync, OpenSSH, and a Python
runtime for the Agent venv). At startup the entrypoint aligns the container user with your mounted
`~/.hermes`, stages the Agent source found under `~/.hermes/hermes-agent` (or the shared
`hermes-agent-src` volume in the two- and three-container variants), builds the sidecar's Agent venv, and
starts the server. `docker-compose.two-container.yml` and `docker-compose.three-container.yml` add the
Agent gateway and the dashboard. Details, GPU images, and failure modes: [docs/docker.md](docs/docker.md).

## Updates

Settings → System checks for updates on the **Stable** (completed release sets) or **Experimental**
(`origin/main`) channel. A recognized clean git checkout of this repository fast-forwards in place, runs the
`npm ci` / `npm run build` steps above, and restarts once active work drains and embedded terminals close; a failed build leaves the old
release stamp and server in place and reports the npm error. Update checks run at startup and every five minutes.
Enable **Automatically apply Web updates** to apply them: source installations can follow Experimental `origin/main`, and direct global
npm installations can install the exact package in a completed Stable release. Containers remain manual image
replacements. Details:
[docs/talaria-updates.md](docs/talaria-updates.md).
The Notifications bell keeps a bounded server-owned history of update progress and results across Web
restarts. Talaria Web and the iPhone app render the same records, including required acknowledgement and
links back to System settings.

## MCP server

`talaria-web-mcp` exposes the same seven session tools as before over the Model Context Protocol, talking to
a running Web instance through its HTTP API (`TALARIA_WEB_URL`, `HERMES_WEBUI_PASSWORD`).

## Development

```bash
cd web
npm ci
npm run build -w packages/contracts
npm run typecheck && npm run lint && npm test      # contracts, server, frontend
npm run openapi                                    # regenerate ../contracts/web-api.openapi.json
sidecar/scripts/test.sh                            # sidecar pytest against the pinned Agent
npm run e2e -w packages/frontend                   # Playwright against the built server
```

`scripts/check web` at the repository root runs the full gate (`scripts/check-web-server`,
frontend checks, and `scripts/check-web-browser`, which uses the fixture replay sidecar so no Agent is
needed). See [TESTING.md](TESTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Talaria is not accepting
outside contributions; see the [contribution policy](../CONTRIBUTING.md).

## Docs

- [docs/onboarding.md](docs/onboarding.md) — first run and provider setup
- [docs/troubleshooting.md](docs/troubleshooting.md) — diagnostics
- [docs/supervisor.md](docs/supervisor.md) — launchd, systemd, supervisord
- [docs/docker.md](docs/docker.md) — container reference
- [docs/talaria-updates.md](docs/talaria-updates.md) — release channels, provenance, migration
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — extension platform
- [docs/architecture/](docs/architecture/) — contract package, sidecar RPC, parity matrices
- [docs/rfcs/](docs/rfcs/) — state and streaming contracts
- [docs/CONTRACTS.md](docs/CONTRACTS.md) — index of subsystem contracts
- [docs/why-hermes.md](docs/why-hermes.md) — background

## Repo

Talaria Web began as a fork of [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui); the
history and contributor credits are preserved in [CONTRIBUTORS.md](CONTRIBUTORS.md) and
[CHANGELOG.md](CHANGELOG.md). Licensed under the MIT license (see the repository root).
