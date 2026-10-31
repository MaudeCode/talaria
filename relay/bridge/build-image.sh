#!/usr/bin/env bash
# Build the feedback bridge as a linux/amd64 OCI archive, then load and check those exact bytes: the image runs as a
# non-root user, exits 2 naming RELAY_URL when unconfigured, and runs smoke.ts (real sharp and ffmpeg sanitization)
# without network access and without shipping the check in the image.
# Usage: build-image.sh REF OUTPUT_DIRECTORY [extra docker buildx build options]
# Writes OUTPUT_DIRECTORY/bridge.oci.tar and OUTPUT_DIRECTORY/image-metadata.json (containerimage.digest).
set -euo pipefail
ref=$1
output=$2
shift 2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$output"
# OCI archive output needs a docker-container builder; a generated name never collides on a shared daemon.
builder=$(docker buildx create --driver docker-container --bootstrap)
trap 'docker buildx rm "$builder" >/dev/null' EXIT
docker buildx build --builder "$builder" --platform linux/amd64 --tag "$ref" "$@" \
  --output "type=oci,dest=$output/bridge.oci.tar" --metadata-file "$output/image-metadata.json" "$here"
# skopeo, not `docker load`: a daemon on the classic image store cannot load an OCI archive.
skopeo copy --quiet "oci-archive:$output/bridge.oci.tar" "docker-daemon:$ref"

run() { docker run --rm --platform linux/amd64 "$@"; }
if [[ "$(run --entrypoint id "$ref" -u)" == 0 ]]; then
  echo "the bridge image runs as root" >&2
  exit 1
fi
status=0
log=$(run "$ref" 2>&1) || status=$?
if [[ "$status" != 2 || "$log" != *"missing RELAY_URL"* ]]; then
  echo "an unconfigured bridge must exit 2 naming RELAY_URL (exit $status): $log" >&2
  exit 1
fi
run --network none --volume "$here/smoke.ts:/bridge/smoke.ts:ro" --volume "$here/fixtures:/bridge/fixtures:ro" "$ref" node smoke.ts
