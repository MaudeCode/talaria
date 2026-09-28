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
count=$(( $(cat "$WAIT_TEST_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$WAIT_TEST_DIR/calls"
[[ "$*" == *"Cache-Control: no-cache"* ]] || { echo "expected an uncached request" >&2; exit 1; }
fixture="$WAIT_TEST_DIR/jobs.$count.json"
[[ -f "$fixture" ]] || fixture=$(ls "$WAIT_TEST_DIR"/jobs.*.json | sort -V | tail -n 1)
filter=""
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$fixture"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" WAIT_TEST_DIR="$work" WAIT_FOR_JOB_POLL_SECONDS=0
export GITHUB_REPOSITORY=MaudeCode/talaria GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=2

# job NAME ATTEMPT STATUS CONCLUSION [UPLOAD_STEP_CONCLUSION]
job() {
  local steps="[]"
  [[ -z "${5:-}" ]] || steps="[{\"name\":\"Build\",\"conclusion\":\"success\"},{\"name\":\"Upload the test build\",\"conclusion\":$5}]"
  printf '{"name":"%s","run_attempt":%s,"status":"%s","conclusion":%s,"steps":%s}' "$1" "$2" "$3" "$4" "$steps"
}
fixtures() { rm -f "$work"/jobs.*.json "$work/calls"; local index=1; for rows in "$@"; do echo "{\"jobs\":[${rows}]}" > "$work/jobs.$index.json"; index=$((index + 1)); done; }
last_line() { tail -n 1 <<< "$1"; }

# Waits while the newest record is running, then passes on its success; other jobs are ignored.
fixtures "$(job "App build" 1 completed '"failure"'),$(job "App build" 2 in_progress null),$(job Other 2 completed '"success"')" \
         "$(job "App build" 1 completed '"failure"'),$(job "App build" 2 completed '"success"')"
[[ "$(last_line "$("$script" "App build")")" == "App build succeeded (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 2 ]]

# A kept earlier success counts; a later attempt than this one does not.
fixtures "$(job "App build" 1 completed '"success"'),$(job "App build" 3 in_progress null)"
[[ "$(last_line "$("$script" "App build")")" == "App build succeeded (attempt 1)." ]]

# Failure, skip and cancellation fail; a missing job times out.
for conclusion in failure skipped cancelled; do
  fixtures "$(job "App build" 2 completed "\"${conclusion}\"")"
  if "$script" "App build" >/dev/null 2>&1; then echo "Expected ${conclusion} to fail." >&2; exit 1; fi
done
fixtures "$(job Other 2 completed '"success"')"
if "$script" "App build" 0 >/dev/null 2>&1; then echo "Expected a missing job to time out." >&2; exit 1; fi

# With a step, its success ends the wait while the job is still finishing; a pending step keeps waiting.
fixtures "$(job "App build" 2 in_progress null null)" "$(job "App build" 2 in_progress null '"success"')"
[[ "$(last_line "$("$script" "App build" 60 "Upload the test build")")" == "App build finished Upload the test build (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 2 ]]
# A failed step does not count, and a job that completed unsuccessfully still fails after its upload.
fixtures "$(job "App build" 2 in_progress null '"failure"')"
if "$script" "App build" 0 "Upload the test build" >/dev/null 2>&1; then echo "Expected a failed upload to time out." >&2; exit 1; fi
fixtures "$(job "App build" 2 completed '"failure"' '"success"')"
if "$script" "App build" 60 "Upload the test build" >/dev/null 2>&1; then echo "Expected a failed build to fail despite its upload." >&2; exit 1; fi

echo "wait-for-job tests passed."
