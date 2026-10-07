#!/usr/bin/env bash
# ci/ui-suite-failed-jobs against a fake gh that replays a synthetic job list and check-run annotations; never calls
# GitHub.
set -euo pipefail
# macOS bash 3.2 ignores a failed [[ ]] under set -e, so every check exits itself.

script="$(cd "$(dirname "$0")" && pwd)/ui-suite-failed-jobs"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
# jobs.json answers the run's job list; annotations.<id>.json answers a check run's annotations.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
filter=""
for (( index = 1; index <= $#; index++ )); do [[ "${!index}" == --jq ]] && { next=$((index + 1)); filter="${!next}"; }; done
if [[ "$*" == *"repos/MaudeCode/talaria/actions/runs/42/jobs?per_page=100"* ]]; then
  jq -r "$filter" "$FAILED_JOBS_TEST_DIR/jobs.json"
elif [[ "$*" =~ repos/MaudeCode/talaria/check-runs/([0-9]+)/annotations ]]; then
  jq -r "$filter" "$FAILED_JOBS_TEST_DIR/annotations.${BASH_REMATCH[1]}.json"
else
  echo "unexpected request: $*" >&2; exit 1
fi
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" FAILED_JOBS_TEST_DIR="$work" GITHUB_REPOSITORY=MaudeCode/talaria

# job ID CONCLUSION NAME
job() { printf '{"id":%s,"conclusion":%s,"name":"%s"}' "$1" "$2" "$3"; }
jobs() { local IFS=,; echo "{\"jobs\":[$*]}" > "$work/jobs.json"; }
timeout_annotation='[{"annotation_level":"failure","message":"The job has exceeded the maximum execution time of 1h0m0s"}]'
expect() {
  local actual
  actual=$("$script" 42)
  [[ "$actual" == "$1" ]] || { echo "Expected $1, got $actual" >&2; exit 1; }
}

# A failed shard counts; passing, skipped and still-running jobs do not.
jobs "$(job 1 '"success"' 'UI suite / UI suite build')" "$(job 2 '"failure"' 'UI suite / UI suite tests (shard 0)')" \
  "$(job 3 null 'Send the failure to the fix agent')" "$(job 4 '"skipped"' 'UI suite / UI suite package tests')"
expect '["UI suite / UI suite tests (shard 0)"]'

# A shard GitHub cancelled at its timeout counts beside a failed one (run 37633596585).
jobs "$(job 2 '"failure"' 'UI suite / UI suite tests (shard 0)')" "$(job 5 '"cancelled"' 'UI suite / UI suite tests (shard 3)')"
echo "$timeout_annotation" > "$work/annotations.5.json"
expect '["UI suite / UI suite tests (shard 0)","UI suite / UI suite tests (shard 3)"]'

# A person's cancel leaves no timeout annotation, so there is nothing to send.
jobs "$(job 6 '"cancelled"' 'UI suite / UI suite tests (shard 1)')" "$(job 7 '"cancelled"' 'UI suite / UI suite build')"
echo '[]' > "$work/annotations.6.json"
echo '[{"annotation_level":"failure","message":"The operation was canceled."}]' > "$work/annotations.7.json"
expect '[]'

echo "ui-suite-failed-jobs checks passed."
