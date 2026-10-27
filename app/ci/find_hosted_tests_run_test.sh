#!/usr/bin/env bash
# ci/find-hosted-tests-run against a fake gh that replays synthetic run and job lists; never calls GitHub.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/find-hosted-tests-run"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
# Each call runs the real jq filter over runs.json or jobs-<run>.json, unless a fail.N (this call) or fail (every
# call) file holds an error for it to print instead.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
count=$(( $(cat "$LOOKUP_TEST_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$LOOKUP_TEST_DIR/calls"
for failure in "$LOOKUP_TEST_DIR/fail.$count" "$LOOKUP_TEST_DIR/fail"; do
  [[ ! -f "$failure" ]] || { cat "$failure" >&2; exit 1; }
done
if [[ "$*" == *"repos/MaudeCode/talaria/actions/workflows/ci.yml/runs?head_sha=${LOOKUP_SHA}&branch=main&event=push&status=completed&per_page=100"* ]]; then
  data="$LOOKUP_TEST_DIR/runs.json"
elif [[ "$*" =~ repos/MaudeCode/talaria/actions/runs/([0-9]+)/jobs\?filter=latest\&per_page=100 ]]; then
  data="$LOOKUP_TEST_DIR/jobs-${BASH_REMATCH[1]}.json"
else
  echo "unexpected request: $*" >&2; exit 1
fi
filter=""
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$data"
EOF
chmod +x "$work/bin/gh"
sha=$(printf 'a%.0s' {1..40})
other=$(printf 'b%.0s' {1..40})
export PATH="$work/bin:$PATH" LOOKUP_TEST_DIR="$work" LOOKUP_SHA="$sha" GH_API_POLL_SECONDS=0 GITHUB_REPOSITORY=MaudeCode/talaria

# run ID HEAD_SHA BRANCH EVENT CONCLUSION [PATH]
run() {
  printf '{"id":%s,"head_sha":"%s","head_branch":"%s","event":"%s","status":"completed","conclusion":"%s","path":"%s"}' \
    "$1" "$2" "$3" "$4" "$5" "${6:-.github/workflows/ci.yml}"
}
runs() { rm -f "$work"/fail* "$work/calls" "$work"/jobs-*.json; local IFS=,; echo "{\"workflow_runs\":[$*]}" > "$work/runs.json"; }
# job ID RUN NAME CONCLUSION [HEAD_SHA]
job() {
  printf '{"id":%s,"name":"%s","head_sha":"%s","status":"completed","conclusion":"%s","html_url":"https://github.com/MaudeCode/talaria/actions/runs/%s/job/%s"}' \
    "$1" "$3" "${5:-$sha}" "$4" "$2" "$1"
}
jobs() { local run=$1; shift; local IFS=,; echo "{\"jobs\":[$*]}" > "$work/jobs-$run.json"; }
fails() { if "$script" "$@" >/dev/null 2>&1; then echo "Expected find-hosted-tests-run $* to fail." >&2; exit 1; fi; }
hosted="App / App hosted tests"

# A successful main push run on exactly this SHA whose hosted tests passed is reused: that job's URL, once.
runs "$(run 7 "$sha" main push success)"
jobs 7 "$(job 70 7 "App / App build" success)" "$(job 71 7 "$hosted" success)" "$(job 72 7 "$hosted" success)"
[[ "$("$script" "$sha")" == "https://github.com/MaudeCode/talaria/actions/runs/7/job/71" ]]

# A later qualifying run is found after an earlier run without the job.
runs "$(run 5 "$sha" main push success)" "$(run 6 "$sha" main push success)"
jobs 5 "$(job 50 5 "App / App build" success)"
jobs 6 "$(job 60 6 "$hosted" success)"
[[ "$("$script" "$sha")" == "https://github.com/MaudeCode/talaria/actions/runs/6/job/60" ]]

# No run qualifies: another commit, another branch or event, a failed or cancelled run, or another workflow file. The
# jobs of a run that does not qualify are never read.
runs "$(run 1 "$other" main push success)" "$(run 2 "$sha" feature push success)" \
     "$(run 3 "$sha" main pull_request success)" "$(run 4 "$sha" main workflow_dispatch success)" \
     "$(run 5 "$sha" main push failure)" "$(run 6 "$sha" main push cancelled)" \
     "$(run 8 "$sha" main push success .github/workflows/other.yml)"
for id in 1 2 3 4 5 6 8; do jobs "$id" "$(job "${id}0" "$id" "$hosted" success)"; done
[[ -z "$("$script" "$sha")" ]]
[[ "$(cat "$work/calls")" == 1 ]]
runs
[[ -z "$("$script" "$sha")" ]]

# A green run that skipped, failed or never ran the hosted tests (a push that left the App alone), or whose job tested
# another commit, does not count.
runs "$(run 9 "$sha" main push success)"
jobs 9 "$(job 90 9 "$hosted" skipped)" "$(job 91 9 "$hosted" failure)" "$(job 92 9 "App / App hosted tests 1" success)" \
       "$(job 93 9 "$hosted" success "$other")" "$(job 94 9 "release / app-hosted-tests / App hosted tests" success)"
[[ -z "$("$script" "$sha")" ]]
[[ "$(cat "$work/calls")" == 2 ]]

# A transient API error is retried; the answer after it counts.
runs "$(run 7 "$sha" main push success)"
jobs 7 "$(job 71 7 "$hosted" success)"
echo "gh: Bad Gateway (HTTP 502)" > "$work/fail.2"
[[ "$("$script" "$sha" 2>/dev/null)" == "https://github.com/MaudeCode/talaria/actions/runs/7/job/71" ]]
[[ "$(cat "$work/calls")" == 3 ]]

# A lookup that cannot finish fails instead of reporting no run: a definitive HTTP error at once, transient errors
# after twelve tries, on either request.
for failing in fail fail.2; do
  for error in "gh: Not Found (HTTP 404)" "gh: Resource not accessible by integration (HTTP 403)"; do
    runs "$(run 7 "$sha" main push success)"
    jobs 7 "$(job 71 7 "$hosted" success)"
    echo "$error" > "$work/$failing"
    fails "$sha"
  done
done
runs "$(run 7 "$sha" main push success)"
jobs 7 "$(job 71 7 "$hosted" success)"
echo 'Get "https://api.github.com/...": net/http: TLS handshake timeout' > "$work/fail"
fails "$sha"
[[ "$(cat "$work/calls")" == 12 ]]

# Only a full commit SHA is accepted.
runs "$(run 7 "$sha" main push success)"
for argument in "" main "${sha:0:12}" "${sha}0" "$(tr a A <<< "$sha")"; do fails "$argument"; done
[[ ! -f "$work/calls" ]]

echo "find-hosted-tests-run tests passed."
