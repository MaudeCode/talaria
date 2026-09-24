# Build the contracts and server packages natively on the build machine: compiling them (and node-pty) under
# emulation for a foreign target is what made multi-platform releases slow (TAL-321). The frontend bundle is
# the committed static/dist tree. node-pty has no Linux prebuilds, so a foreign target cross-compiles it.
FROM --platform=$BUILDPLATFORM node:24-slim AS node-build
ARG TARGETARCH
WORKDIR /apptoo
COPY . /apptoo
RUN set -eu \
    && native=$(dpkg --print-architecture) \
    && apt-get update \
    && apt-get install -y --no-install-recommends make g++ python3 \
    && if [ "$TARGETARCH" != "$native" ]; then \
         case "$TARGETARCH" in \
           amd64) triple=x86_64-linux-gnu toolchain=g++-x86-64-linux-gnu npm_arch=x64 ;; \
           arm64) triple=aarch64-linux-gnu toolchain=g++-aarch64-linux-gnu npm_arch=arm64 ;; \
           *) echo "no cross toolchain for $TARGETARCH" >&2; exit 1 ;; \
         esac; \
         apt-get install -y --no-install-recommends "$toolchain"; \
         export CC="$triple-gcc" CXX="$triple-g++" npm_config_arch="$npm_arch" npm_config_cpu="$npm_arch"; \
       fi \
    && npm ci --no-audit --no-fund --include=dev --workspace packages/contracts --workspace packages/server \
    && npm run build --workspace packages/contracts \
    && npm run build --workspace packages/server \
    && npm prune --omit=dev --no-audit --no-fund --workspace packages/contracts --workspace packages/server \
    && rm -rf /root/.npm

FROM node:24-slim

LABEL maintainer="MaudeCode"
LABEL description="Talaria Web — TypeScript server and browser interface for Hermes Agent"
LABEL org.opencontainers.image.source="https://github.com/MaudeCode/talaria"

# Install system packages
ENV DEBIAN_FRONTEND=noninteractive

# Make use of apt-cacher-ng if available
RUN if [ "A${BUILD_APT_PROXY:-}" != "A" ]; then \
        echo "Using APT proxy: ${BUILD_APT_PROXY}"; \
        printf 'Acquire::http::Proxy "%s";\n' "$BUILD_APT_PROXY" > /etc/apt/apt.conf.d/01proxy; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

RUN apt-get update -y --fix-missing --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    apt-utils \
    locales \
    ca-certificates \
    curl \
    rsync \
    openssh-client \
    git \
    xz-utils \
    python3 \
    python3-venv \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Optional GPU user-space acceleration libraries for users who pass through
# host GPU devices. The default image remains CPU-only.
ARG INSTALL_GPU_LIBS=0
RUN if [ "$INSTALL_GPU_LIBS" = "1" ]; then \
        apt-get update -y --fix-missing --no-install-recommends \
        && apt-get install -y --no-install-recommends \
            libva2 \
            vainfo \
            mesa-va-drivers \
        && if apt-cache show intel-media-va-driver-non-free >/dev/null 2>&1; then \
            apt-get install -y --no-install-recommends intel-media-va-driver-non-free; \
        else \
            echo "intel-media-va-driver-non-free is not available from the configured Debian repositories; skipping Intel non-free VA-API driver."; \
        fi \
        && apt-get clean \
        && rm -rf /var/lib/apt/lists/*; \
    else \
        echo "Skipping optional GPU user-space acceleration libraries (INSTALL_GPU_LIBS=0)."; \
    fi

# UTF-8
RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG=en_US.utf8
ENV LC_ALL=C

# The Python variables apply to the sidecar and the Agent venv it runs on.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    NODE_ENV=production

WORKDIR /apptoo

# Create the unprivileged runtime user. The entrypoint starts as root only for
# UID/GID alignment and filesystem preparation, then execs the server as this user.
RUN groupadd -g 1024 hermeswebui \
    && useradd -u 1024 -d /home/hermeswebui -g hermeswebui -G users -s /bin/bash -m hermeswebui \
    && mkdir -p /app /uv_cache /workspace \
    && chown -R hermeswebui:hermeswebui /home/hermeswebui /app /uv_cache /workspace \
    && chmod 0755 /home/hermeswebui \
    && chmod 1777 /app /uv_cache /workspace

COPY --chmod=555 docker_init.bash /hermeswebui_init.bash

RUN touch /.within_container

# Remove APT proxy configuration and clean up APT downloaded files
RUN rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/01proxy \
    && apt-get clean

USER root

# Pre-install uv system-wide so the container doesn't need internet access at runtime
# to create the Agent venv the sidecar runs on. Installing as root places uv in
# /usr/local/bin, available to all users; the init script skips the download when
# uv is already on PATH.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# The workspace built natively above: sources, contracts/server dist and production node_modules only.
COPY --from=node-build --chown=root:root /apptoo /apptoo
# A node-pty built for the wrong architecture would only fail at the first terminal; fail the build instead.
RUN node -e 'require("node-pty")'

# Bake the git version tag into the image so the settings badge works even
# when .git is not present (it is excluded by .dockerignore).
# CI passes: --build-arg HERMES_VERSION=$(git describe --tags --always)
# Local builds that omit the arg get "unknown" as the fallback.
ARG HERMES_VERSION=unknown
ENV TALARIA_WEB_VERSION=${HERMES_VERSION}

# The release workflow supplies the exact JSON emitted by stamp-release.py.
# An unstamped local image has an empty label and reports development at /health.
ARG TALARIA_PROVENANCE={}
LABEL dev.talaria.provenance="${TALARIA_PROVENANCE}"
RUN node --input-type=module -e 'import { existsSync } from "node:fs"; import { loadReleaseInfo } from "/apptoo/packages/server/dist/release.js"; const canon = (v) => JSON.stringify(v, Object.keys(v).sort()); const expected = existsSync("/apptoo/_release.json") ? loadReleaseInfo({ webRoot: "/apptoo" }) : {}; const actual = JSON.parse(process.env.TALARIA_PROVENANCE); if (canon(actual) !== canon(expected)) { console.error("Container label must match stamped Web provenance"); process.exit(1) }'

# Default to binding all interfaces (required for container networking)
ENV HERMES_WEBUI_HOST=0.0.0.0
ENV HERMES_WEBUI_PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=8s --start-period=10s --retries=3 \
  CMD bash /apptoo/scripts/lib/health_probe.sh localhost 8787 /health 2 >/dev/null || exit 1

# docker_init.bash performs root-only bind-mount setup, then drops to hermeswebui
# before starting the WebUI server. The production image does not ship sudo.
USER root
CMD ["/hermeswebui_init.bash"]
