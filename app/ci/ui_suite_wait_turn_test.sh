#!/usr/bin/env bash
# ci/ui-suite-wait-turn --once against a fake gh that replays synthetic runs and jobs; never calls GitHub.
set -euo pipefail
# macOS bash 3.2 ignores a failed [[ ]] under set -e, so every check exits itself.

script="$(cd "$(dirname "$0")" && pwd)/ui-suite-wait-turn"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
filter=""
for argument in "$@"; do
  case "$argument" in
    *"/actions/workflows/ui-suite.yml/runs?"*)
      # Every page of the last day's runs, not just the newest 100.
      [[ "$*" == *--paginate* && "$argument" == *"&created=%3E%3D20"* ]] || { echo "unbounded run list: $*" >&2; exit 1; }
      file="$QUEUE_TEST_DIR/runs.json" ;;
    *"/actions/runs/"*"/jobs?"*) id=${argument#*/actions/runs/}; file="$QUEUE_TEST_DIR/jobs.${id%%/*}.json" ;;
  esac
done
[[ -n "${file:-}" && -f "$file" ]] || { echo "unexpected request: $*" >&2; exit 1; }
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$file"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" QUEUE_TEST_DIR="$work" GH_API_POLL_SECONDS=0 GITHUB_REPOSITORY=MaudeCode/talaria

# run ID STATUS BRANCH TITLE
run() { printf '{"id":%s,"status":"%s","head_branch":"%s","display_title":"%s"}' "$1" "$2" "$3" "$4"; }
# runs RUN...; each later "jobs ID QUEUE_STATUS QUEUE_CONCLUSION" (or "jobs ID none") writes that run's jobs
runs() { rm -f "$work"/*.json; local IFS=,; echo "{\"workflow_runs\":[$*]}" > "$work/runs.json"; }
jobs() {
  if [[ "$2" == empty ]]; then echo '{"jobs":[]}'
  elif [[ "$2" == none ]]; then echo '{"jobs":[{"name":"UI suite / UI suite build","status":"in_progress","conclusion":null}]}'
  else printf '{"jobs":[{"name":"Queue","status":"%s","conclusion":%s}]}' "$2" "$3"; fi > "$work/jobs.$1.json"
}
expect() { # expect go|wait RUN_ID
  local code=0
  "$script" "$2" --once >/dev/null 2>&1 || code=$?
  [[ "$1" == go && "$code" == 0 || "$1" == wait && "$code" == 10 ]] || { echo "Expected $1 for run $2, exit $code." >&2; exit 1; }
}
me=100

# Alone, or only behind finished runs: its turn.
runs "$(run $me in_progress fix/x 'UI suite on x')" "$(run 90 completed fix/y 'UI suite on y')"
expect go $me
# An older waiting run of the same rank goes first.
runs "$(run $me in_progress fix/x 'UI suite on x')" "$(run 90 queued fix/y 'UI suite on y')"
expect wait $me
# Priority (main, or a "(priority)" name) goes ahead of older ordinary runs that are still waiting...
for mine in "$(run $me in_progress main 'UI suite on x')" "$(run $me in_progress fix/x 'UI suite on x (priority)')"; do
  runs "$mine" "$(run 90 in_progress fix/y 'UI suite on y')"; jobs 90 in_progress null
  expect go $me
  # ...but never past one already running.
  jobs 90 completed '"success"'
  expect wait $me
done
# An older priority run waits ahead of a newer one, and both go ahead of an ordinary run.
runs "$(run $me in_progress fix/x 'UI suite on x (priority)')" "$(run 90 queued main 'UI suite on y')"
expect wait $me
runs "$(run 80 in_progress fix/x 'UI suite on x')" "$(run 90 queued main 'UI suite on y')"
expect wait 80
# A running run behind it in rank still holds the suite: one from before the queue, with no Queue job, too.
runs "$(run $me in_progress fix/x 'UI suite on x')" "$(run 120 in_progress fix/y 'UI suite on y')"
jobs 120 completed '"success"'
expect wait $me
jobs 120 none
expect wait $me
# Not when its Queue job is still waiting or failed, or it has not started.
jobs 120 in_progress null
expect go $me
jobs 120 completed '"failure"'
expect go $me
runs "$(run $me in_progress fix/x 'UI suite on x')" "$(run 120 queued fix/y 'UI suite on y')"; jobs 120 empty
expect go $me
# A run from before the queue whose jobs wait for runners is reported queued, but it has started.
jobs 120 none
expect wait $me
# A run that cannot see itself yet waits.
runs "$(run 120 queued fix/y 'UI suite on y')"
expect wait $me
# A lookup that fails waits instead of starting.
rm -f "$work/runs.json"
expect wait $me

# Waiting past the limit exits 20 instead of running into the job's timeout.
runs "$(run $me in_progress fix/x 'UI suite on x')" "$(run 90 queued fix/y 'UI suite on y')"
code=0
UI_SUITE_QUEUE_POLL_SECONDS=1 UI_SUITE_QUEUE_LIMIT_SECONDS=2 "$script" $me >/dev/null 2>&1 || code=$?
[[ "$code" == 20 ]] || { echo "Expected exit 20 at the limit, got $code." >&2; exit 1; }

echo "ui-suite-wait-turn tests passed."
