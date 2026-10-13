#!/bin/bash
set -euo pipefail

# Keep /opt/hermes on the image filesystem so a stale volume cannot hide its tools.
source_dir=/opt/hermes
shared_dir=/var/lib/talaria/hermes-agent-src
marker="$shared_dir/.talaria-source-revision"
ready=/tmp/talaria-agent-source-ready
rm -f "$ready"
mountpoint -q "$shared_dir" || { echo "Agent source volume is not mounted" >&2; exit 1; }

revision=$(python3 - <<'PY'
import json
from pathlib import Path
import re

source = Path('/opt/hermes')
stamp = source / 'install-stamp.json'
# Older images embed their OCI revision in .hermes_build_sha instead of a stamp.
revision = json.loads(stamp.read_text())['commit'] if stamp.exists() else (source / '.hermes_build_sha').read_text().strip()
if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
    raise SystemExit('Agent image has no valid source revision')
print(revision)
PY
)

# Serialize writers if two containers are accidentally started on the same cache.
exec 9>"$shared_dir/.talaria-source.lock"
flock -x 9
if [[ ! -f "$marker" || "$(cat "$marker")" != "$revision" ]]; then
    echo "Refreshing shared Agent source to $revision"
    # Remove the completion marker first. An interrupted copy is retried on restart.
    rm -f "$marker"
    find "$shared_dir" -mindepth 1 -maxdepth 1 ! -name .talaria-source.lock -exec rm -rf -- {} +
    cp -a "$source_dir/." "$shared_dir/"
    printf '%s\n' "$revision" > "$marker.tmp"
    mv -f "$marker.tmp" "$marker"
else
    echo "Shared Agent source already at $revision"
fi
flock -u 9
exec 9>&-
touch "$ready"

# Preserve upstream PID 1 supervision, UID/GID remapping, and command handling.
exec /opt/hermes/docker/entrypoint-dispatch.sh "$@"
