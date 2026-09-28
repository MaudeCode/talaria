#!/usr/bin/env bash
# ci/wait-for-job against a fake gh that replays synthetic job lists; never calls GitHub.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/wait-for-job"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
# Each call prints the next fixture's rows (then keeps printing the last) through the real jq filter.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"/artifacts?name="* ]]; then
  echo "{\"total_count\": $(cat "$WAIT_TEST_DIR/artifacts" 2>/dev/null || echo 0)}" | jq -r "${@: -1}"
  exit
fi
count=$(( $(cat "$WAIT_TEST_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$WAIT_TEST_DIR/calls"
fixture="$WAIT_TEST_DIR/jobs.$count.json"
[[ -f "$fixture" ]] || fixture=$(ls "$WAIT_TEST_DIR"/jobs.*.json | sort -V | tail -n 1)
filter=""
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$fixture"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" WAIT_TEST_DIR="$work" WAIT_FOR_JOB_POLL_SECONDS=0
export GITHUB_REPOSITORY=MaudeCode/talaria GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=2

job() { printf '{"name":"%s","run_attempt":%s,"id":%s,"status":"%s","conclusion":%s}' "$@"; }
fixtures() { rm -f "$work"/jobs.*.json "$work/calls" "$work/artifacts"; local index=1; for rows in "$@"; do echo "{\"jobs\":[${rows}]}" > "$work/jobs.$index.json"; index=$((index + 1)); done; }

# Waits while the newest record is running, then passes on its success; other jobs are ignored.
fixtures "$(job "App build" 1 10 completed '"failure"'),$(job "App build" 2 11 in_progress null),$(job Other 2 12 completed '"success"')" \
         "$(job "App build" 1 10 completed '"failure"'),$(job "App build" 2 11 completed '"success"')"
[[ "$("$script" "App build")" == "App build succeeded (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 2 ]]

# A kept earlier success counts; a later attempt than this one does not.
fixtures "$(job "App build" 1 10 completed '"success"'),$(job "App build" 3 13 in_progress null)"
[[ "$("$script" "App build")" == "App build succeeded (attempt 1)." ]]

# Failure, skip and cancellation fail; a missing job times out.
for conclusion in failure skipped cancelled; do
  fixtures "$(job "App build" 2 11 completed "\"${conclusion}\"")"
  if "$script" "App build" 2>/dev/null; then echo "Expected ${conclusion} to fail." >&2; exit 1; fi
done
fixtures "$(job Other 2 12 completed '"success"')"
if "$script" "App build" 0 2>/dev/null; then echo "Expected a missing job to time out." >&2; exit 1; fi

# With an artifact, its upload ends the wait while the job is still finishing; a failed job still fails.
fixtures "$(job "App build" 2 11 in_progress null)"
[[ -z "$("$script" "App build" 0 app-build 2>/dev/null)" ]] || { echo "Expected no artifact to time out." >&2; exit 1; } || true
echo 1 > "$work/artifacts"
[[ "$("$script" "App build" 60 app-build)" == "App build uploaded app-build (attempt 2)." ]]
fixtures "$(job "App build" 2 11 completed '"failure"')"
echo 1 > "$work/artifacts"
if "$script" "App build" 60 app-build 2>/dev/null; then echo "Expected a failed build to fail despite its artifact." >&2; exit 1; fi

echo "wait-for-job tests passed."
