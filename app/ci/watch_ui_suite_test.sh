#!/usr/bin/env bash
# ci/watch-ui-suite against a fake gh that answers from synthetic run, status, job and artifact files; never calls GitHub.
set -euo pipefail
# macOS bash 3.2 ignores a failed [[ ]] under set -e, so every check exits itself.

script="$(cd "$(dirname "$0")" && pwd)/watch-ui-suite"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
filter="."
for (( index = 1; index <= $#; index++ )); do [[ "${!index}" == --jq ]] && { next=$((index + 1)); filter="${!next}"; }; done
case "$*" in
  *"/statuses"*) file=statuses.json ;;
  *"/jobs"*) file=jobs.json ;;
  *"/artifacts"*) file=artifacts.json ;;
  *"actions/runs/42"*) file=run.json ;;
  *) echo "unexpected request: $*" >&2; exit 1 ;;
esac
jq -r "$filter" "$WATCH_TEST_DIR/$file"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" WATCH_TEST_DIR="$work" GITHUB_REPOSITORY=MaudeCode/talaria WATCH_UI_SUITE_POLL_SECONDS=0

# state RUN-STATUS RUN-CONCLUSION JOBS-JSON STATUSES-JSON ARTIFACTS-JSON
state() {
  printf '{"head_sha":"abc","run_started_at":"2026-10-07T21:49:00Z","status":"%s","conclusion":%s}' "$1" "$2" > "$work/run.json"
  printf '{"jobs":%s}' "$3" > "$work/jobs.json"
  printf '%s' "$4" > "$work/statuses.json"
  printf '{"artifacts":%s}' "$5" > "$work/artifacts.json"
}
expect() { # expect EXIT OUTPUT CAP
  local output status=0
  output=$("$script" 42 "${3:-5}") || status=$?
  [[ "$status" == "$1" && "$output" == "$2" ]] || { echo "Expected $1 '$2', got $status '$output'" >&2; exit 1; }
}
running='[{"name":"UI suite / UI suite tests (shard 0)","status":"in_progress","conclusion":null,"steps":[{"name":"Test without building","status":"in_progress","conclusion":null}]}]'
failed_step='[{"name":"UI suite / UI suite tests (shard 2)","status":"in_progress","conclusion":null,"steps":[{"name":"Test without building","status":"completed","conclusion":"failure"}]}]'

# A shard's failure status from this run returns at once, while the job still runs; an older run's is ignored.
state in_progress null "$running" '[{"state":"failure","context":"UI suite failures (shard 0)","description":"1 failed, latest ChatUITests.testSend","created_at":"2026-10-07T22:00:00Z"}]' '[]'
expect 1 "FAILED TEST UI suite failures (shard 0): 1 failed, latest ChatUITests.testSend"
state in_progress null "$running" '[{"state":"failure","context":"UI suite failures (shard 0)","description":"old","created_at":"2026-10-07T20:00:00Z"}]' '[]'
expect 3 "CAP" 1

# A failed test step returns once its shard's result artifact exists.
state in_progress null "$failed_step" '[]' '[]'
expect 3 "CAP" 1
state in_progress null "$failed_step" '[]' '[{"id":7,"name":"ui-suite-build-test-results-shard-2"}]'
expect 1 "FAILED STEP UI suite / UI suite tests (shard 2) artifact=ui-suite-build-test-results-shard-2"

# A test job that failed or was cancelled otherwise returns too.
state in_progress null '[{"name":"UI suite / UI suite tests (shard 3)","status":"completed","conclusion":"cancelled","steps":[]}]' '[]' '[]'
expect 1 "FAILED JOB UI suite / UI suite tests (shard 3)"

# A successful run passes; a failed one outside the test jobs fails.
state completed '"success"' "$running" '[]' '[]'
expect 0 "PASSED"
state completed '"failure"' "$running" '[]' '[]'
expect 1 "FAILED RUN failure"

echo "watch-ui-suite checks passed."
