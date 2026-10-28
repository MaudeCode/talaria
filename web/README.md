# Talaria Web

Talaria Web is the browser interface for [Hermes Agent](https://github.com/NousResearch/hermes-agent):
a TypeScript server on Node 24 that serves a React frontend, keeps your sessions and settings, and runs
the Agent through a small Python sidecar on the Agent's own virtual environment. It is one component of
the [Talaria monorepo](../README.md) next to the iOS app and the Relay.

- **Server** — `packages/server`, published as `@maudecode/talaria-web` (bins `talaria-web`, `talaria-web-mcp`).
- **Contracts** — `packages/contracts`, published as `@maudecode/talaria-web-contracts`: every route, SSE
  event, and sidecar RPC method as Zod schemas; the OpenAPI document at `../contracts/web-api.openapi.json`
  is generated from it and consumed by the iOS app.
- **Frontend** — `packages/frontend`, a TanStack Start / React SPA. CI builds it into `static/dist/`, which ships
  inside the npm package and the container image, so installs need no frontend toolchain. It is not committed.
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
`$HERMES_HOME/.env` is agent-writable, so the server only takes credentials from it (names ending in `_KEY`,
`_TOKEN`, or `_SECRET`), `HERMES_MODEL`, and a few tuning knobs (port, upload and session limits, bot name, default
model); it warns about the rest. Set other `HERMES_WEBUI_*` settings, `HERMES_HOME`, or interpreter hooks such as
`NODE_OPTIONS` in the process environment or the checkout `.env`. The Agent still reads the whole file itself.

```text
talaria-web [port] [--host HOST] [--no-browser] [--skip-agent-install] [--foreground]
talaria-web serve [args]                            run the server in this process (supervised worker)
talaria-web ctl <start|stop|restart|status|logs>    daemon control
talaria-web-mcp                                     MCP server over the HTTP API
```

From a source checkout (for contributors; it never updates itself):

```bash
git clone --filter=blob:none --sparse --single-branch https://github.com/MaudeCode/talaria.git talaria
git -C talaria sparse-checkout set web contracts scripts
cd talaria/web
npm ci
npm run build:fast    # contracts, server, and the frontend bundle in static/dist
node packages/server/dist/bin/talaria-web.js
```

Update a checkout with `git pull`, then run `npm ci` and `npm run build:fast` again.

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
| `HERMES_WEBUI_PYTHON` | Agent venv | Interpreter override for installs without a PM environment; leave it unset for PM installs. Otherwise the PM generation recorded under the Hermes root's `installs/`, then `<agent>/venv` or `.venv` for older installs |
| `HERMES_WEBUI_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for all IPv4, `::` for all IPv6) |
| `HERMES_WEBUI_PORT` | `8787` | Port |
| `HERMES_HOME` | `~/.hermes` | Hermes state base directory |
| `HERMES_DATA_DIR_SUFFIX` | empty | Literal suffix for the default Agent home, e.g. `-desktop` selects `~/.hermes-desktop` or `%LOCALAPPDATA%\hermes-desktop` on Windows; ignored when `HERMES_HOME` is explicit |
| `HERMES_CONFIG_PATH` | `$HERMES_HOME/config.yaml` | Hermes config file; the sidecar reads and writes this exact path (a symlink is updated through its target) |
| `HERMES_WEBUI_STATE_DIR` | `$HERMES_HOME/webui` | Sessions, settings, auth records, journals, shares |
| `HERMES_WEBUI_DEFAULT_WORKSPACE` | `~/workspace` | Default workspace |
| `HERMES_WEBUI_CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code transcripts listed read-only when **Show Claude Code sessions** is on |
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
| `HERMES_WEBUI_MAX_EXTRACTED_MB` | 10 × upload limit | Total bytes one archive upload may extract (zip, tar, gzip, bzip2, xz); archives also stop at 10,000 files |
| `HERMES_WEBUI_MAX_SSE_CLIENTS` | 8 per client | Concurrent stream cap per client identity |
| `HERMES_WEBUI_EXTENSION_DIR`, `HERMES_WEBUI_EXTENSION_MANIFEST` | unset | Local extensions ([docs](docs/EXTENSIONS.md)) |
| `HERMES_WEBUI_PLUGINS_DIR` | `$HERMES_HOME/plugins` | Dashboard plugins (`<name>/dashboard/manifest.json`), each off until enabled under `dashboard_plugins` in settings.json ([docs](docs/architecture/extension-migration-guide.md#8-dashboard-plugins)) |
| `HERMES_WEBUI_EXTERNAL_NOTES_SOURCES` | unset | Notes drawer sources; Joplin search and preview read `JOPLIN_URL` (default `http://127.0.0.1:41184`) and `JOPLIN_TOKEN` from the `joplin` MCP server's `env`, then the environment |
| `WIKI_PATH` | `~/wiki` | LLM wiki root for `/api/wiki/*`; also read from the profile `.env`, then `skills.config.wiki.path` or `wiki.path` in config.yaml |
| `HERMES_WEBUI_LOG_FILE`, `HERMES_WEBUI_LOG_MAX_BYTES` | detached log, 32 MiB | Size-bounded server log |
| `HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS`, `HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT`, `HERMES_WEBUI_RUN_JOURNAL_FSYNC` | 14, 3, auto | Run journal retention |
| `HERMES_WEBUI_SESSIONS_MAX` | 100 | Session cache size (prefer `webui.sessions_cache_max` in `config.yaml`) |
| `HERMES_WEBUI_FOREGROUND` | auto | Force attached mode (supervisors are auto-detected) |
| `HERMES_WEBUI_PRESERVE_ENV`, `HERMES_WEBUI_NO_DOTENV` | unset | `.env` precedence controls |
| `HERMES_WEBUI_SIDECAR_COMMAND` | unset | Replace the sidecar spawn command (test fixtures only) |
| `TALARIA_RELEASE_TOKEN` | unset | GitHub token with Contents read for private release lookups ([docs](docs/talaria-updates.md)) |

Public authentication request bodies are limited to 64 KiB, including chunked requests;
larger bodies receive HTTP 413. Authenticated routes retain their existing limits.
Access logs include `forwarded_for` only when `HERMES_WEBUI_TRUST_FORWARDED_FOR` is enabled
and the connection comes from a trusted proxy. The value uses the same validated
client-IP selection as rate limiting and is limited to 256 characters.

### How chat runs

`/reasoning hide` hides reasoning in Web and iOS streams, saved-history views,
activity details and exports. `/reasoning show` restores it. Stored reasoning and
the generic running indicator remain available. The Web-specific display setting
takes precedence over the global setting, including quoted boolean values.

On a new chat, **Earlier conversations** selects up to five retained conversations
in the active profile. The chat stores their accepted search pointers and titles,
without copying transcripts. The Agent can consult them with `session_search`.
Unavailable, retired, deleted, or changed source identities refuse creation so
you can select again. References inherit source-history privacy requirements.
References are available for ordinary chats; diagnostic modes refuse them.

In the Web sidebar, drag a conversation onto **Pinned** to pin it, or from Pinned
onto an ordinary date group to unpin it. Empty drop targets appear while dragging;
collapsed groups still accept drops. The conversation menu provides the same actions
with keyboard and touch access.

Talaria-created chats run `run_agent.AIAgent` in-process on the Agent venv, reading the profile's
`HERMES_HOME` config. Existing canonical Agent conversations use their original gateway owner when it
offers the authenticated `hermes-gateway-v1` session protocol. Opening or leaving a conversation never
starts, restarts, or stops that owner. An unavailable or incompatible owner keeps the conversation
read-only; Talaria never starts a second Agent for it.

Owner conversations support text follow-ups, canonical approvals and clarifications, Stop, queued-input
cancellation, editing and steering when the owner allows them, and explicit recovery of an unknown execution. Retry returns unknown work to the composer
for review; it does not execute it. Model and workspace changes use the owner's revision and generation
fences. File uploads and direct-worker-only controls are unavailable on this connection. A native CLI
turn using a whole clarification batch remains read-only because the owner cannot replay that pending
request to a new viewer; continue it in its native client. Secure setup and sudo passwords are not
tunneled through Web. Dedicated profile owners use native private-control tickets rather than the
retired HTTP gateway URL/key settings. Profiles served by a shared multiplexer can use canonical
sessions when the owner's exact boot revision has passed Talaria's profile-isolation contract.
Unverified owners remain read-only. Diagnostic fresh chats still require a dedicated owner.

To use an external OpenAI-compatible endpoint as a model, add it in **Settings → Providers**.

Chat prompts omit the session ID by default so new chats can share the provider's prompt cache.
If a skill needs its own session ID, set `webui.pass_session_id: true` in the profile's `config.yaml`.
The ID is then appended after the shared prompt, including on background turns. Values `true`,
`yes`, `on`, and `1` enable it, case-insensitively; other or missing values leave it off.

Ordinary sends use fresh, confirmed model-catalog evidence for automatic model repair. A cold, stale,
or unavailable catalog keeps the selected model and provider while discovery refreshes in the
background. Concurrent picker and repair refreshes share discovery for the same profile and source
generation. Explicit model configuration changes retain their validation.

Settings → Preferences → **Speed** lists the tiers the installed Agent supports
for the default model and its endpoint. Fast and Ultrafast may cost more. The
setting applies only to turns on that default model; unsupported routes show no
speed control.

The composer's session toolsets control lists the profile's toolsets and marks unavailable choices.
Use **Use profile defaults** to remove the session override. An operator's `agent.disabled_toolsets`
always applies, including to saved overrides, cached chat Agents, and manual compression. Catalog
availability is read from the server; a failed catalog load leaves selection disabled.

Settings → System → **MCP Servers → Cost policy** shows declared tool estimates,
per-chat limits and whether each value comes from native config or a portable package.
These are declared estimates, not vendor bills. Edit one native policy field at a time;
**Use inherited/default** removes that key, while zero explicitly disables a limit and
an empty tool-cost object clears the table. Package-only declarations are read-only;
an existing native server override can change or inherit package values. Edits reject
stale config and preserve transport, trust and unrelated settings. Saving does not
reload a runtime or change another owner's frozen policy. Use the existing
**Reload MCP** command explicitly for the profile; the inspector does not claim that
saved policy is active. The Agent owns budget enforcement and approvals.

The first MCP discovery for a profile waits for its tools before chat starts. Later turns wait at most
two seconds for discovery, then use the registered tools while connections finish in the background.
The composer shows a notice while that turn is waiting for more tools.

Settings → Plugins shows available updates from the Agent's last stored plugin check, without
fetching on each visit. Update applies the revision through the Agent's security scan. A caution
verdict requires confirmation for that profile, installation, revision and scan result. Changed or
expired confirmation requires a fresh review; a dangerous verdict blocks the update. New dependency consent
continues in `hermes plugins update` in a terminal. Older Agents without cached update support
show no update controls.

**Catalog** in Plugins settings browses the Agent's bounded, cached reviewed catalog by name,
description, tier or category. Details show the source, reviewed pin, requirements and installed
identity. **Install disabled** previews the exact staged tree, then asks the server owner to confirm.
Confirmation expires or becomes invalid when the profile, entry, pin or tree changes. The native
Agent scan and package admission still apply. Installation never replaces an existing plugin,
enables it, approves dependencies, grants host capabilities or permits a sidecar proxy. Native
Desktop contributions are unverified and do not run in Talaria. A lost acknowledgment refreshes
the installed identity without replaying the install. Agents without this native boundary show an
update requirement.

Skills → a skill → **Saved revisions** inspects history from the enabled, consented,
reviewed Hermetic backend. It shows real saved revisions, known provenance and a text
comparison. Missing, ambiguous or unverifiable history stays unavailable. Inspection
does not create history, migrate plugin data, run saved checks or change a skill.

Select text within a chat message, then choose **Quote selection** to append it as a Markdown quote
to the current draft. The action keeps the draft, attachments and cursor, and never sends a message.
Quoting stops active dictation so later speech results cannot replace the quote.
Selections over 16,000 characters are left to the browser selection menu.

Automatic read-aloud claims each watched reply once across tabs on the same browser origin and app mount,
account, profile, and session. The browser retains the last 1024 automatic attempts, including interrupted
attempts. If coordination storage is unavailable, automatic playback stays quiet; **Read aloud** remains
available. Opening saved history does not start automatic playback.

Deliberately archiving a stored Talaria chat notifies its profile plugins through the Agent's
`on_session_delete` hook with `reason=archive`, after the local archive commits. Repeated archive
requests, unarchive and automatic cleanup send no event. This notification preserves the chat,
approvals and Agent database; plugin failures do not undo the archive. Older Agents without the
emitter retain the existing archive behavior.

Opening or refreshing Settings → Connectors never provisions a Nous identity or refreshes credentials.
Without an identity, Agents with a public catalog let you browse apps; older Agents offer sign-in.
Rules stay off and read-only until the portal returns them. Sign in or choose **Connect** to authorize
account setup; after signing in through the Agent, refresh the page to load that account.
For a guest with connected apps, Hermes may schedule a sign-in offer. **Not now**
keeps its native backoff, and the offer stays available across reloads until handled.
A connected-app sighting may set Hermes' existing guest flag; it never creates or
refreshes credentials. Sign-in starts only when chosen, and its account and app
transfer result stays readable until **Continue**.

The Memory page offers **Preview compaction** for saved Memory and User profile entries. It uses the configured
Compression auxiliary model, shows the source, proposal and diff, and saves only after **Apply compaction**.
The preview expires after 30 minutes and is bound to the profile and saved revision. A changed source requires a
new preview; a refusal keeps the review visible. Secret-bearing and explicitly protected entries stay unchanged
and never enter the model request. Because memory files do not record per-entry history privacy metadata,
compaction requires an auxiliary route that enforces both no-training and zero-retention restrictions.
An unavailable or incompatible route reports an error without saving. SOUL and project context remain outside compaction.

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

Settings → System checks for updates on the **Stable** (completed release sets) or **Experimental** (each passing
`main` commit, published to GHCR) channel. A direct global npm installation installs the exact package in a completed
Stable release or the verified Experimental artifact, then restarts once active work drains and embedded terminals
close. Changing the channel switches the installation on its next update, in either direction. Update checks run at
startup and every five minutes; enable **Automatically apply Web updates** to apply them. Source checkouts are for
contributors and report a manual update: update them with git. Containers remain manual image replacements. Details:
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
- [docs/architecture/](docs/architecture/) — contract package, sidecar RPC, frontend layout
- [docs/rfcs/](docs/rfcs/) — state and streaming contracts
- [docs/CONTRACTS.md](docs/CONTRACTS.md) — index of subsystem contracts

## Repo

Talaria Web began as a fork of Hermes WebUI; [NOTICE](NOTICE) keeps the upstream MIT attribution.
Licensed under the MIT license (see the repository root).

Session storage defaults to the existing JSON format. `TALARIA_STORAGE=json` selects that adapter explicitly; other values fail startup.
