#!/usr/bin/env bash
# ci/wait-for-job against a fake gh that replays synthetic job lists; never calls GitHub.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/wait-for-job"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
# Each call prints the next fixture's rows (then keeps printing the last) through the real jq filter, unless a
# fail.N (this call) or fail (every call) file holds an error for it to print instead.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
count=$(( $(cat "$WAIT_TEST_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$WAIT_TEST_DIR/calls"
for failure in "$WAIT_TEST_DIR/fail.$count" "$WAIT_TEST_DIR/fail"; do
  [[ ! -f "$failure" ]] || { cat "$failure" >&2; exit 1; }
done
[[ "$*" == *"Cache-Control: no-cache"* ]] || { echo "expected an uncached request" >&2; exit 1; }
fixture="$WAIT_TEST_DIR/jobs.$count.json"
[[ -f "$fixture" ]] || fixture=$(ls "$WAIT_TEST_DIR"/jobs.*.json | sort -V | tail -n 1)
filter=""
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$fixture"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" WAIT_TEST_DIR="$work" WAIT_FOR_JOB_POLL_SECONDS=0 GH_API_POLL_SECONDS=0
export GITHUB_REPOSITORY=MaudeCode/talaria GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=2

# job NAME ATTEMPT STATUS CONCLUSION [UPLOAD_STEP_CONCLUSION]
job() {
  local steps="[]"
  [[ -z "${5:-}" ]] || steps="[{\"name\":\"Build\",\"conclusion\":\"success\"},{\"name\":\"Upload the test build\",\"conclusion\":$5}]"
  printf '{"name":"%s","run_attempt":%s,"status":"%s","conclusion":%s,"steps":%s}' "$1" "$2" "$3" "$4" "$steps"
}
fixtures() { rm -f "$work"/jobs.*.json "$work"/fail* "$work/calls"; local index=1; for rows in "$@"; do echo "{\"jobs\":[${rows}]}" > "$work/jobs.$index.json"; index=$((index + 1)); done; }
last_line() { tail -n 1 <<< "$1"; }

# Waits while the newest record is running, then passes on its success; other jobs are ignored.
fixtures "$(job "App build" 1 completed '"failure"'),$(job "App build" 2 in_progress null),$(job Other 2 completed '"success"')" \
         "$(job "App build" 1 completed '"failure"'),$(job "App build" 2 completed '"success"')"
[[ "$(last_line "$("$script" "App build")")" == "App build succeeded (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 2 ]]

# A job in a called workflow matches by its own name; a different job sharing a suffix does not.
fixtures "$(job "App / App build" 2 completed '"success"'),$(job "Other App build" 2 completed '"failure"')"
[[ "$(last_line "$("$script" "App build")")" == "App build succeeded (attempt 2)." ]]

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

# The UI suite shards' handoff (TAL-405). An upload already visible on the first poll returns after that one call.
fixtures "$(job "App build" 2 in_progress null '"success"')"
[[ "$(last_line "$("$script" "App build" 2700 "Upload the test build")")" == "App build finished Upload the test build (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 1 ]]
# A build that fails or is cancelled before its upload fails on the poll that sees it, not at the timeout.
for conclusion in failure cancelled; do
  fixtures "$(job "App build" 2 in_progress null null)" "$(job "App build" 2 completed "\"${conclusion}\"" '"skipped"')"
  if output=$("$script" "App build" 2700 "Upload the test build" 2>&1); then echo "Expected a ${conclusion} build to fail." >&2; exit 1; fi
  [[ "$(last_line "$output")" == "App build finished ${conclusion} (attempt 2)" ]]
  [[ "$(cat "$work/calls")" == 2 ]]
done
# "Re-run failed jobs" on a shard alone: attempt 2 has only the build record kept from attempt 1.
fixtures "$(job "App build" 1 completed '"success"' '"success"')"
[[ "$(last_line "$("$script" "App build" 2700 "Upload the test build")")" == "App build succeeded (attempt 1)." ]]
[[ "$(cat "$work/calls")" == 1 ]]
# A re-run that rebuilds waits for the new attempt's upload, not attempt 1's failed build.
fixtures "$(job "App build" 1 completed '"failure"' '"skipped"'),$(job "App build" 2 in_progress null null)" \
         "$(job "App build" 1 completed '"failure"' '"skipped"'),$(job "App build" 2 in_progress null '"success"')"
[[ "$(last_line "$("$script" "App build" 2700 "Upload the test build")")" == "App build finished Upload the test build (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 2 ]]
# The shards' gate (TAL-413): a queued build with no steps keeps it waiting; the build's runner setup ends it.
fixtures '{"name":"App build","run_attempt":2,"status":"queued","conclusion":null,"steps":[]}' \
         '{"name":"App build","run_attempt":2,"status":"in_progress","conclusion":null,"steps":[{"name":"Set up job","conclusion":"success"}]}'
[[ "$(last_line "$("$script" "App build" 20700 "Set up job")")" == "App build finished Set up job (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 2 ]]
# Each observation logs its call's duration, the latency a shard's step summary reports.
fixtures "$(job "App build" 2 completed '"success"')"
[[ "$("$script" "App build" | head -n 1)" =~ ^[0-9:]{8}\ App\ build:\ attempt\ 2\ completed\ success\ \([0-9]+s\ call\)$ ]]

# Transient API errors are retried at the poll cadence (TAL-404): a TLS timeout twice, then the upload succeeded.
tls='Get "https://api.github.com/repos/MaudeCode/talaria/actions/runs/1/jobs?filter=all&per_page=100&poll=35": net/http: TLS handshake timeout'
fixtures "$(job "App build" 2 in_progress null '"success"')"
echo "$tls" > "$work/fail.1"; echo "$tls" > "$work/fail.2"
output=$("$script" "App build" 60 "Upload the test build" 2>&1)
[[ "$(last_line "$output")" == "App build finished Upload the test build (attempt 2)." ]]
[[ "$(grep -c "TLS handshake timeout" <<< "$output")" == 2 ]]
[[ "$(cat "$work/calls")" == 3 ]]
# HTTP 5xx, 429 and a secondary rate limit (a 403) are transient too.
fixtures "$(job "App build" 2 completed '"success"')"
echo "gh: Bad Gateway (HTTP 502)" > "$work/fail.1"
echo "gh: Too Many Requests (HTTP 429)" > "$work/fail.2"
echo "gh: You have exceeded a secondary rate limit. (HTTP 403)" > "$work/fail.3"
[[ "$(last_line "$("$script" "App build" 2>/dev/null)")" == "App build succeeded (attempt 2)." ]]
[[ "$(cat "$work/calls")" == 4 ]]
# Twelve consecutive errors fail with a clear message.
fixtures "$(job "App build" 2 completed '"success"')"
echo "$tls" > "$work/fail"
if output=$("$script" "App build" 2>&1); then echo "Expected 12 consecutive API errors to fail." >&2; exit 1; fi
[[ "$(last_line "$output")" == "Giving up after 12 consecutive GitHub API errors." ]]
[[ "$(cat "$work/calls")" == 12 ]]
# Errors that outlast the wait's timeout end it there.
fixtures "$(job "App build" 2 completed '"success"')"
echo "$tls" > "$work/fail"
if output=$("$script" "App build" 0 2>&1); then echo "Expected API errors past the timeout to fail." >&2; exit 1; fi
[[ "$(last_line "$output")" == "Timed out after 1 consecutive GitHub API errors." ]]
# A definitive HTTP error such as a 404 or 401 fails on the first call.
for error in "gh: Not Found (HTTP 404)" "gh: Bad credentials (HTTP 401)"; do
  fixtures "$(job "App build" 2 completed '"success"')"
  echo "$error" > "$work/fail"
  if output=$("$script" "App build" 2>&1); then echo "Expected ${error} to fail." >&2; exit 1; fi
  [[ "$(cat "$work/calls")" == 1 ]]
  [[ "$output" == *"${error}"* ]]
done
# The download step's artifact lookup calls ci/gh-api-poll directly and gets only the successful response.
fixtures "$(job "App build" 2 completed '"success"')"
echo "$tls" > "$work/fail.1"
[[ "$("$(dirname "$script")/gh-api-poll" -H "Cache-Control: no-cache" jobs --jq '.jobs[0].name' 2>/dev/null)" == "App build" ]]

echo "wait-for-job tests passed."
