# Talaria Web — Docker setup guide

This is the comprehensive Docker reference. For a 5-minute quickstart, see the [README Docker section](../README.md#docker).

Talaria's multi-container files use the tested Agent image digest from
[`sidecar/agent_dependency.json`](../sidecar/agent_dependency.json), shared by the gateway
and dashboard. Keep that file alongside the Compose files when copying a setup.
Updating an existing source volume still requires the source-volume procedure
below; changing an image does not replace files already stored in a named volume.

Published images carry the same release metadata as `/health` in the
`dev.talaria.provenance` label. The build rejects a label that differs from its
stamped metadata. Local, unstamped images use an empty provenance label and
report development metadata. Release identity contains no credentials or host
paths.

## TL;DR — pick one

| Setup | When to use | File |
|---|---|---|
| **Single-container** (recommended) | You just want chat working. The container runs the Agent from your mounted `~/.hermes/hermes-agent` through its sidecar. | `docker-compose.yml` |
| **Two-container** | You want isolation between gateway (CLI/Telegram/cron) and chat UI. | `docker-compose.two-container.yml` |
| **Three-container** | Two-container PLUS the dashboard for monitoring. | `docker-compose.three-container.yml` |

### Published images and local builds

The canonical package is `ghcr.io/maudecode/talaria-web`. The completed
`release-set.json` supplies its immutable `@sha256:` reference. Set that reference
as `TALARIA_WEB_IMAGE` in the Compose environment, authenticate to GHCR if private,
then run `docker compose pull` followed by `docker compose up -d --no-build`.
The same procedure works with the two- and three-container `-f` variants.

Without `TALARIA_WEB_IMAGE`, each variant builds the checked-out Web source and
names the local image `ghcr.io/maudecode/talaria-web:local`. That local name is not
a published release. Stable source tags use `web-vX.Y.Z`; experimental source tags
use `web-exp-vX.Y.Z`. Both channels resolve through completed release sets.

If something stops working, **start with the single-container setup** — it's the simplest path and fixes most permission/UID/path-mismatch issues by construction.

## Production image security model

The production Docker image is hardened for the normal single-tenant container threat model:
Talaria Web assumes one operator controls the container, mounted Hermes home, and workspace.
The image does **not** install `sudo`, does not add runtime users to a sudo group, and does not
grant `NOPASSWD` escalation. If an agent/tool process gains a shell as `hermeswebui`, it should
not be able to become root with a passwordless sudo command.

The entrypoint still starts as `root` for a narrow init phase because Docker bind mounts often need
UID/GID alignment and ownership preparation before the app can read `~/.hermes`, `/workspace`,
`/app`, and `/uv_cache`. After that setup, `docker_init.bash` re-execs itself as the unprivileged
`hermeswebui` user and starts the server there. Init scratch files under `/tmp/hermeswebui_init`
are owner-only (`0700` directory, `0600` files), not world-writable.

For multi-tenant or hostile-container environments, rebuild with your own runtime user, mount policy,
and supervisor assumptions. Development images that need package-manager convenience should add
those tools in a dev-only Dockerfile instead of reintroducing passwordless sudo to production.

## 5-minute quickstart (single container)

```bash
git clone --filter=blob:none --sparse https://github.com/MaudeCode/talaria.git talaria
git -C talaria sparse-checkout set web contracts scripts
cd talaria/web
cp .env.docker.example .env
# Edit .env if needed (most users can skip this on Linux)
docker compose up -d
open http://localhost:8787
```

That's it for a real personal Docker install. Your existing `~/.hermes`
directory is mounted, your `~/workspace` is browsable, and the WebUI
auto-detects your UID/GID from the mounted volume.

The single-container setup runs the WebUI only. It can create cron jobs and run
them manually from the Tasks panel. In Docker, scheduled jobs require the Hermes gateway daemon
to tick while you are away. If System Settings shows `Gateway not configured`,
use `docker-compose.two-container.yml`,
`docker-compose.three-container.yml`, or run `hermes gateway` separately before
relying on offline scheduled runs. See [Scheduled jobs and the gateway daemon](#scheduled-jobs-and-the-gateway-daemon) below for the full background and verification steps.

For troubleshooting, reinstall, or onboarding reproduction trials, do not mount
your real `~/.hermes` unless you intentionally want to test real state. Use an
isolated Hermes home and follow
[`docs/onboarding-agent-checklist.md`](onboarding-agent-checklist.md) instead.

> **Linux note**: run Compose as the user who owns the Hermes home. The command
> `sudo docker compose up -d` can make Compose expand `${HOME}` as `/root`, so
> the default `${HOME}/.hermes` bind mount becomes `/root/.hermes` instead of
> your user's real Hermes directory. Prefer adding your user to the `docker group`
> and running `docker compose up -d`; if you must preserve the caller environment
> for a one-off root run, use `sudo -E docker compose up -d` and verify the
> rendered mount with `docker compose config` first.

## Optional GPU runtime image

The default image stays CPU-only. GPU user-space packages are installed only
when you build a custom image with the opt-in build arg:

```bash
docker build --build-arg INSTALL_GPU_LIBS=1 -t talaria-web:gpu .
```

That build path installs VA-API basics (`libva2`, `vainfo`), AMD Mesa VA-API
drivers (`mesa-va-drivers`), and the Intel non-free media driver when that
package is available from the configured Debian repositories. NVIDIA host
runtime tooling is not installed into the app image; use the NVIDIA Container
Toolkit on the host and pass GPUs through at runtime.

GPU passthrough still depends on host drivers, Docker runtime support, and
device mappings. The commands below are configuration guidance for a suitable
Linux Docker host; they are not a claim that native GPU passthrough was verified
in this workspace.

### Intel and AMD VA-API

Expose the host render devices and add the runtime user to the common video and
render groups:

```bash
docker run --rm \
  --device /dev/dri:/dev/dri \
  --group-add video \
  --group-add render \
  talaria-web:gpu vainfo
```

For Compose, add the same mapping to a custom service definition:

```yaml
services:
  hermes-webui:
    image: talaria-web:gpu
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - video
      - render
```

`vainfo` should list the VA-API driver and supported profiles when the host
driver stack and container permissions are correct. The container entrypoint
preserves Docker-provided supplemental groups before it drops privileges to the
`hermeswebui` runtime user, so the WebUI process keeps access to `/dev/dri`.

### NVIDIA

Install and configure the NVIDIA Container Toolkit on the host first, then use
Docker's GPU runtime flag:

```bash
docker run --rm --gpus all talaria-web:gpu nvidia-smi
```

For Compose, use a custom service with GPU access enabled:

```yaml
services:
  hermes-webui:
    image: talaria-web:gpu
    gpus: all
```

If `nvidia-smi` is unavailable or reports no devices, fix the host NVIDIA driver
and container toolkit setup before debugging Talaria Web. The container image
only supplies Talaria Web plus optional user-space media libraries; it cannot
provide host kernel drivers or the NVIDIA runtime.

## Scheduled jobs and the gateway daemon

**Symptom**: Cron jobs created in the Tasks panel never fire. System Settings or Tasks shows:

- Orange "Gateway not configured", or
- Red "Gateway metadata stale" when runtime metadata is stale, or
- Red "Gateway endpoint not reachable" when WebUI has a gateway URL configured but cannot reach its health endpoint.

**Cause**: Scheduled cron ticks are not driven by the WebUI itself. The gateway daemon ticks the scheduler every 60 seconds; without one running, scheduled jobs sit idle. "Run now" / "Trigger" buttons still work because the WebUI handles those in-process.

The cron list itself is still read from the shared `HERMES_HOME` volume, not
from the gateway HTTP API. If the Tasks panel shows a gateway warning while the
job list loads, the warning is about scheduled ticking / gateway health, not
about the list endpoint.

In older gateway builds, or when the daemon runs in a separate container, `gateway_state.json` can become stale and WebUI may lose confidence even if the daemon is up. This is especially visible if the WebUI container has no gateway URL and can only inspect local state files from its own container.

**Fix**: Run a gateway container alongside the WebUI. The two-container compose file is the recommended path:

```bash
cp .env.docker.example .env
docker compose -f docker-compose.two-container.yml up -d
```

The compose files forward `API_SERVER_KEY` from `.env` into the `hermes-agent`
container. The agent only starts the gateway API listener (port 8642) when
`API_SERVER_KEY` is a usable value (>=16 chars) — `API_SERVER_ENABLED` alone
does nothing. Without a key, the gateway daemon still runs but port 8642 stays
unbound and the WebUI keeps showing **"Gateway endpoint not reachable"**. To
enable scheduled ticking and the green gateway pill, set a long random string
in `.env`:

```bash
echo "API_SERVER_KEY=$(openssl rand -hex 24)" >> .env
docker compose -f docker-compose.two-container.yml up -d --force-recreate
```

The compose file forwards the same value to the WebUI as
`HERMES_WEBUI_GATEWAY_API_KEY`, so the health probe authenticates automatically.

The three-container layout adds the dashboard but is otherwise the same shape. If you must stay single-container, you can run `hermes gateway` inside the container as a long-lived background process, but the compose split is sturdier.

If you maintain a custom compose file, make sure the **WebUI service** points at
the gateway service over the compose network:

```yaml
services:
  hermes-webui:
    environment:
      - HERMES_API_URL=http://hermes-agent:8642
      # HERMES_WEBUI_GATEWAY_BASE_URL=http://hermes-agent:8642 also works.
```

Do not copy only `API_SERVER_ENABLED=true` / `API_SERVER_HOST=0.0.0.0` into the
agent service as a standalone fix. If you intentionally enable the agent API
server, the agent also requires a real `API_SERVER_KEY` (at least 8 characters),
and the WebUI still needs `HERMES_API_URL` or `HERMES_WEBUI_GATEWAY_BASE_URL` to
reach that service from its container.

**Verify**: Once the gateway is up, the System Settings pill should turn green and the Tasks banner disappear. From the host:

```bash
export GATEWAY_BASE_URL="${HERMES_API_URL:-${HERMES_WEBUI_GATEWAY_BASE_URL:-http://hermes-agent:8642}}"
docker compose -f docker-compose.two-container.yml exec hermes-agent hermes gateway status
curl -sS "${GATEWAY_BASE_URL%/}/health/detailed" | jq '.gateway_state, .state'
```

If the service name differs in your compose file, `docker compose -f docker-compose.two-container.yml ps` lists the running services.
For container-to-container diagnostics, set one of `HERMES_API_URL` or `HERMES_WEBUI_GATEWAY_BASE_URL` in the WebUI environment, then restart WebUI.


## What goes wrong (and how to fix it)

### Compatibility policy and version pinning

Each Talaria Web release is tested against one Hermes Agent release, pinned in
[`sidecar/agent_dependency.json`](../sidecar/agent_dependency.json). The
multi-container Compose files take the Agent image digest from that file, so
Web and Agent upgrade together. The sidecar checks the loaded Agent revision at
startup and the server reports drift. Do not swap in `hermes-agent:latest`;
after changing the Agent image, follow
[Upgrading the agent container](#upgrading-the-agent-container).

### 1. "Permission denied" at startup

**Symptom**: Container starts but immediately crashes, logs show:
```
EACCES: permission denied, open '/home/hermeswebui/.hermes/...'
```

**Cause**: The container's user (UID 1000 by default) can't read your bind-mounted directory because your host files are owned by a different UID.

**Fix**: Set `UID` and `GID` in `.env` to match your host:
```bash
echo "UID=$(id -u)" >> .env
echo "GID=$(id -g)" >> .env
docker compose down && docker compose up -d
```

On macOS, host UIDs start at 501. On Linux, the first interactive user is usually UID 1000.

> **macOS Docker Desktop**: if UID mapping still misbehaves after the env fix, try toggling **Settings → General → File sharing implementation** between VirtioFS and gRPC-FUSE. Different implementations preserve UIDs across the host/container boundary differently.

### 2. Credential and home directory modes

The Agent skips its `0600` enforcement inside containers, so Talaria Web
tightens `.env`, `auth.json`, `google_token.json`, and
`google_client_secret.json` in `HERMES_HOME` at startup: any group or world
access becomes `0600`. When `HERMES_HOME_MODE` is set, only world access is
removed, so group-shared credentials keep working. Set `HERMES_SKIP_CHMOD=1`
to leave every mode alone.

`HERMES_HOME_MODE` is the Agent's `HERMES_HOME` *directory* mode: a value
without the owner execute bit (such as `0640`) stops the Agent from traversing
its own home. Use `0750` (group-traversable) or `0701` (execute only) when
sharing the home between containers.

### 3. "Workspace appears empty even though my files are there"

**Symptom**: WebUI loads but `/workspace` shows no files.

**Cause**: Same as #1 — UID mismatch on the bind mount.

**Fix**: Same as #1 — match host UID/GID via `.env`.

### 4. "Two-container setup: WebUI can't find agent source"

**Symptom**: WebUI logs at startup:
```
!! WARNING: hermes-agent source not found.
!!   Looked in: /home/hermeswebui/.hermes/hermes-agent
!!              /opt/hermes
```

**Cause**: The agent's source (`/opt/hermes` inside the agent container) needs to be exposed to the WebUI container via a shared volume. The two-container compose file does this via `hermes-agent-src` named volume, but if you're using bind mounts incorrectly the path won't resolve.

**Fix**: Use the named volumes that ship with `docker-compose.two-container.yml` — don't replace them with bind mounts unless you know what you're doing. The agent container writes its source to `/opt/hermes`, and the WebUI mounts that volume at `/home/hermeswebui/.hermes/hermes-agent`.

If you must use a bind mount: pick a host path, then mount it to `/opt/hermes` in the agent container AND `/home/hermeswebui/.hermes/hermes-agent` in the WebUI container.

### 5. "Tools missing in two-container setup"

**Symptom**: You ask the agent to run a tool in chat and it errors with `command not found`.

**Cause**: Chat turns run through the sidecar **inside the WebUI container**, not the agent container, so tools come from the WebUI image. It ships git, curl, rsync, the OpenSSH client, Python 3, and Node, and nothing else by design.

**Fix**: Extend the `Dockerfile` with the tools you need, or use a remote terminal backend (see [remote-workspaces.md](remote-workspaces.md)).

### 6. "config.yaml not loaded"

**Symptom**: You have a `config.yaml` in your host `~/.hermes/`, but the WebUI shows "no model configured" or doesn't pick up your custom providers.

**Cause**: Either the file isn't readable (UID/GID issue, see #1) or it's not in the expected path inside the container.

**Fix**:
- Verify: `docker exec hermes-webui ls -la /home/hermeswebui/.hermes/config.yaml`
- If it doesn't exist: your host bind mount is pointing at the wrong directory.
- If it exists but is unreadable: see #1 for the UID/GID fix.

### 7. "On Podman: can't share .hermes between containers"

**Symptom**: Two-container setup works on Docker but fails on Podman with permission errors no matter what UID/GID you set.

**Cause**: Podman 3.4 (Ubuntu 22.04 default) has limited support for `userns_mode: keep-id` across multiple containers — files written by one container appear with a different UID in the other.

**Fix**: Either upgrade to Podman 4+ (which fixes this) or use the [single-container setup](#5-minute-quickstart-single-container).

### 8. "API base URL set to localhost fails from Docker"

**Symptom**: A provider, local model server, webhook, or custom API works on the host at `http://localhost:<port>`, but fails when the same URL is configured in Talaria Web running in Docker.

**Cause**: Inside a container, `localhost` means *that container*, not your laptop/host. The WebUI process cannot reach host services through `127.0.0.1` unless the service is running inside the same container.

**Fix**: Point Docker-hosted WebUI at the host gateway name instead:

- Docker Desktop on macOS/Windows: `http://host.docker.internal:<port>`
- Podman: `http://host.containers.internal:<port>`
- Linux Docker Engine: either publish the host service on the Docker bridge address, or add a host-gateway alias to your compose service:

```yaml
services:
  hermes-webui:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then configure the URL as `http://host.docker.internal:<port>`. Also ensure the host service binds to an address reachable from containers (not only a loopback interface the Docker bridge cannot reach) and that your host firewall allows the connection.

### 9. UID/GID auto-detection

Without an explicit `WANTED_UID`/`WANTED_GID`, `docker_init.bash` takes the
owner of the first match:

1. `$HERMES_WEBUI_STATE_DIR` (default `/app/data`), a bind mount in a
   single-container deploy, so its owner is the host identity to match
2. `/home/hermeswebui/.hermes`, `$HERMES_HOME`, `/opt/data`, the shared
   hermes-home volume in multi-container setups
3. `/workspace`, used only when nothing above resolves
4. `1024`, the fallback default

Root-owned candidates (UID 0, for example a freshly created named volume) are
skipped. An explicit `WANTED_UID`/`WANTED_GID` always wins, including `1024`.
If detection picks the wrong owner, set both explicitly:

```bash
docker run -e WANTED_UID=$(id -u) -e WANTED_GID=$(id -g) ...
```

## Multi-container architecture

The two- and three-container setups use **named Docker volumes** (not bind mounts) by default for a reason: named volumes solve the UID/GID problem by construction. Docker creates the volume's root directory with the correct ownership, all containers reading/writing to it see the same files, no host-side permission setup required.

```
                 ┌─────────────────────────────────┐
                 │      hermes-home (volume)       │
                 │  (config, sessions, state, ...)  │
                 └─────────────────────────────────┘
                          ↑              ↑
                          │ rw           │ rw
                          │              │
      ┌──────────────┐    │              │    ┌──────────────┐
      │ hermes-agent │────┘              └────│ hermes-webui │
      │  (port 8642) │                        │  (port 8787) │
      └──────────────┘                        └──────────────┘
              │                                       ↑
              │ rw                                    │ ro
              ↓                                       │
      ┌─────────────────────────┐                     │
      │ hermes-agent-src (vol)  │─────────────────────┘
      │ (agent's Python source)  │
      └─────────────────────────┘
```

The WebUI container doesn't ship with the agent — at startup it stages the source from the shared volume into `/app/hermes-agent-src`, builds the venv its Python sidecar runs on (`uv venv` + `uv pip install -e .[all]`), and reuses it on later restarts. The WebUI mount is read-only; the agent container is the only writer.

## Upgrading the agent container

The `hermes-agent-src` named volume is initialised from the agent image's `/opt/hermes` on first `up`. Docker reuses the volume verbatim on every subsequent `up` — **even after `docker pull` of a newer agent image**. The cached volume content masks the new image's source tree, so pulling a newer agent image does not by itself give you the new agent code, dependencies, or entrypoint.

To upgrade the agent image cleanly, drop the source volume before recreating:

```bash
# Two-container setup
docker compose -f docker-compose.two-container.yml down
docker volume rm <project>_hermes-agent-src
docker compose -f docker-compose.two-container.yml pull
docker compose -f docker-compose.two-container.yml up -d

# Three-container setup
docker compose -f docker-compose.three-container.yml down
docker volume rm <project>_hermes-agent-src
docker compose -f docker-compose.three-container.yml pull
docker compose -f docker-compose.three-container.yml up -d
```

Replace `<project>` with your Compose project name (the parent directory by default; check with `docker volume ls`). The `hermes-home` volume (config, sessions, state) is left untouched — only `hermes-agent-src` (the agent's source) is recreated; the staged copy and venv under `/app` are rebuilt on the next container recreation.

> The single-container setup (`docker-compose.yml`) does not use `hermes-agent-src` and is not affected by this upgrade pattern — pulling a newer WebUI image and `docker compose up -d --force-recreate` is sufficient.

## What the multi-container setup isolates (and what it doesn't)

The two- and three-container setups give you **process, network, and resource isolation** between the gateway and the chat UI:

- Each service has its own PID namespace and lifecycle — the agent process can crash without taking down the chat UI and vice versa.
- The gateway API (port 8642) is bound by the agent service only; the WebUI cannot bind it. Other containers reach the gateway via the `hermes-net` Docker network.
- Resource limits (`deploy.resources.limits` in `docker-compose.three-container.yml`) apply per service, so you can cap the agent independently of the dashboard.
- Restart policies, log streams, and container health checks are scoped per service.

What multi-container does **not** isolate:

- **Filesystem boundary.** Both services share `hermes-home` (config, sessions, state), and the WebUI mounts the agent's installed source from `hermes-agent-src`. The WebUI mount is read-only, but the agent service still has write access, and both services share the home volume.
- **UID/GID boundary.** Both services default to `${UID:-1000}` so files written by one are readable by the other. If you align them to different UIDs you'll get permission errors on the shared volume.
- **Trust boundary on the agent source.** The WebUI's sidecar runs Agent code from the staged copy of the shared `hermes-agent-src` volume. The read-only mount means a compromised WebUI cannot rewrite the agent source, but it does run code from that volume.

If you need **filesystem isolation** between the chat UI and the agent (e.g. you don't trust the WebUI to read agent state), the multi-container setup is not enough — run the agent on a separate host and connect the WebUI to it via the gateway HTTP API. If you don't need any boundary, the single-container setup is simpler.

The source mount only gets Agent code into the container; the server itself imports no Agent code and talks to the Agent only through the sidecar ([architecture/agent-api-contract.md](architecture/agent-api-contract.md)). If you customize the compose files with bind mounts, keep the WebUI-side agent source mount read-only unless you are intentionally doing local development; `docker_init.bash` warns at startup when that path is writable.

## Bind-mount migration (advanced)

If you really need to bind-mount an existing host `~/.hermes` (e.g. you're keeping config in dotfiles, sharing with a non-Docker `hermes` install, etc.):

```yaml
volumes:
  hermes-home:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /home/youruser/.hermes
  hermes-agent-src:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/hermes-agent-source
```

**Critical requirements**:

1. The host directory MUST be readable by your container UID. Run `id -u` on the host and ensure `~/.hermes` is owned by that UID (or readable via group bits).
2. ALL containers sharing the volume must run as the SAME UID/GID. Set `UID=$(id -u)` and `GID=$(id -g)` in `.env`.
3. If you run Compose with sudo, do not rely on `${HOME}` defaults: `sudo` often changes `$HOME` to `/root`, so `${HERMES_HOME:-${HOME}/.hermes}` becomes `/root/.hermes`. Prefer running Docker as your user; otherwise pass absolute paths with `sudo -E`, for example `HERMES_HOME=/home/youruser/.hermes HERMES_WORKSPACE=/home/youruser/workspace sudo -E docker compose up -d`, and confirm the rendered bind mount with `docker compose config`.

## Reference

- [`docker-compose.yml`](../docker-compose.yml) — single container (recommended)
- [`docker-compose.two-container.yml`](../docker-compose.two-container.yml) — agent + webui
- [`docker-compose.three-container.yml`](../docker-compose.three-container.yml) — agent + dashboard + webui
- [`.env.docker.example`](../.env.docker.example) — environment variable template
- [`Dockerfile`](../Dockerfile) — single-container build
- [`docker_init.bash`](../docker_init.bash) — container entrypoint script

For a new failure mode not covered here, collect:

1. Which compose file you used
2. The error from `docker logs hermes-webui`
3. `docker exec hermes-webui id` output
4. `docker exec hermes-webui ls -la /home/hermeswebui/.hermes` output
