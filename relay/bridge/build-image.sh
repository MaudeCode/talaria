#!/usr/bin/env bash
# Build the feedback bridge as a linux/amd64 OCI archive, then load and check those exact bytes in both modes. Bridge
# mode runs as a non-root user and exits 2 naming RELAY_URL when unconfigured. Sanitizer mode starts the way it is
# deployed (read-only root, bounded /tmp, only its token, an internal network without outbound access) as a non-root
# process, and smoke.ts proves its real sharp and ffmpeg sanitization from a second container without shipping the check.
# Usage: build-image.sh REF OUTPUT_DIRECTORY [extra docker buildx build options]
# Writes OUTPUT_DIRECTORY/bridge.oci.tar and OUTPUT_DIRECTORY/image-metadata.json (containerimage.digest).
set -euo pipefail
ref=$1
output=$2
shift 2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$output"
# OCI archive output needs a docker-container builder; generated names never collide on a shared daemon.
builder=$(docker buildx create --driver docker-container --bootstrap)
network=""
sanitizer=""
cleanup() {
  if [[ -n "$sanitizer" ]]; then docker rm --force "$sanitizer" >/dev/null; fi
  if [[ -n "$network" ]]; then docker network rm "$network" >/dev/null; fi
  docker buildx rm "$builder" >/dev/null
}
trap cleanup EXIT
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

token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
network=$(docker network create --internal "bridge-smoke-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')")
sanitizer=$(docker run --detach --platform linux/amd64 --network "$network" --read-only --tmpfs /tmp:size=256m \
  --env SANITIZER_TOKEN="$token" "$ref" node sanitizer.ts)
# PID 1 is the sanitizer's node process.
if [[ "$(docker exec "$sanitizer" stat -c %u /proc/1)" == 0 ]]; then
  echo "the sanitizer runs as root" >&2
  exit 1
fi
address=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$sanitizer")
if ! run --network "$network" --env SANITIZER_URL="http://$address:8080" --env SANITIZER_TOKEN="$token" \
  --volume "$here/smoke.ts:/bridge/smoke.ts:ro" --volume "$here/fixtures:/bridge/fixtures:ro" "$ref" node smoke.ts; then
  echo "sanitizer log:" >&2
  docker logs "$sanitizer" >&2
  exit 1
fi
