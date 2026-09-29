#!/usr/bin/env bash
# ci/find-ui-suite-run against a fake gh that replays a synthetic run list; never calls GitHub.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/find-ui-suite-run"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
# Each call runs the real jq filter over runs.json, unless a fail.N (this call) or fail (every call) file holds an
# error for it to print instead.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
count=$(( $(cat "$LOOKUP_TEST_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$LOOKUP_TEST_DIR/calls"
for failure in "$LOOKUP_TEST_DIR/fail.$count" "$LOOKUP_TEST_DIR/fail"; do
  [[ ! -f "$failure" ]] || { cat "$failure" >&2; exit 1; }
done
[[ "$*" == *"repos/MaudeCode/talaria/actions/workflows/ui-suite.yml/runs?head_sha=${LOOKUP_SHA}&status=completed"* ]] ||
  { echo "unexpected request: $*" >&2; exit 1; }
filter=""
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$LOOKUP_TEST_DIR/runs.json"
EOF
chmod +x "$work/bin/gh"
sha=$(printf 'a%.0s' {1..40})
other=$(printf 'b%.0s' {1..40})
export PATH="$work/bin:$PATH" LOOKUP_TEST_DIR="$work" LOOKUP_SHA="$sha" GH_API_POLL_SECONDS=0 GITHUB_REPOSITORY=MaudeCode/talaria

# run ID HEAD_SHA STATUS CONCLUSION EVENT TITLE
run() {
  printf '{"id":%s,"head_sha":"%s","status":"%s","conclusion":%s,"event":"%s","display_title":"%s","html_url":"https://github.com/MaudeCode/talaria/actions/runs/%s"}' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$1"
}
runs() { rm -f "$work"/fail* "$work/calls"; local IFS=,; echo "{\"workflow_runs\":[$*]}" > "$work/runs.json"; }
fails() { if "$script" "$@" >/dev/null 2>&1; then echo "Expected find-ui-suite-run $* to fail." >&2; exit 1; fi; }

# A successful nightly or dispatch on exactly this SHA is reused; the newest match is printed once.
runs "$(run 3 "$sha" completed '"success"' schedule "UI suite on $sha")" "$(run 2 "$sha" completed '"success"' workflow_dispatch "UI suite on $sha")"
[[ "$("$script" "$sha")" == "https://github.com/MaudeCode/talaria/actions/runs/3" ]]
runs "$(run 2 "$sha" completed '"success"' workflow_dispatch "UI suite on $sha")"
[[ "$("$script" "$sha")" == "https://github.com/MaudeCode/talaria/actions/runs/2" ]]

# Nothing qualifies: another commit's success, a failure, a cancellation, a run still in progress, a scoped
# dispatch, a dispatch that tested another ref, a run from before run names recorded the commit, or another event.
runs "$(run 1 "$other" completed '"success"' schedule "UI suite on $other")" \
     "$(run 2 "$other" completed '"success"' schedule "UI suite on $sha")" \
     "$(run 3 "$sha" completed '"failure"' schedule "UI suite on $sha")" \
     "$(run 4 "$sha" completed '"cancelled"' workflow_dispatch "UI suite on $sha")" \
     "$(run 5 "$sha" in_progress null workflow_dispatch "UI suite on $sha")" \
     "$(run 6 "$sha" completed '"success"' workflow_dispatch "UI suite (scoped) on $sha")" \
     "$(run 7 "$sha" completed '"success"' workflow_dispatch "UI suite on $other")" \
     "$(run 8 "$sha" completed '"success"' workflow_dispatch "UI suite on main")" \
     "$(run 9 "$sha" completed '"success"' schedule "UI suite")" \
     "$(run 10 "$sha" completed '"success"' push "UI suite on $sha")"
output=$("$script" "$sha")
[[ -z "$output" ]]
[[ "$(cat "$work/calls")" == 1 ]]
runs
[[ -z "$("$script" "$sha")" ]]

# A transient API error is retried; the answer after it counts.
runs "$(run 2 "$sha" completed '"success"' schedule "UI suite on $sha")"
echo "gh: Bad Gateway (HTTP 502)" > "$work/fail.1"
[[ "$("$script" "$sha" 2>/dev/null)" == "https://github.com/MaudeCode/talaria/actions/runs/2" ]]
[[ "$(cat "$work/calls")" == 2 ]]

# A lookup that cannot finish fails instead of reporting no run: a definitive HTTP error at once, transient errors
# after twelve tries.
for error in "gh: Not Found (HTTP 404)" "gh: Resource not accessible by integration (HTTP 403)" \
             'Get "https://api.github.com/...": net/http: TLS handshake timeout'; do
  runs "$(run 2 "$sha" completed '"success"' schedule "UI suite on $sha")"
  echo "$error" > "$work/fail"
  fails "$sha"
done
[[ "$(cat "$work/calls")" == 12 ]]

# Only a full commit SHA is accepted.
runs "$(run 2 "$sha" completed '"success"' schedule "UI suite on $sha")"
for argument in "" main "${sha:0:12}" "${sha}0" "$(tr a A <<< "$sha")"; do fails "$argument"; done
[[ ! -f "$work/calls" ]]

echo "find-ui-suite-run tests passed."
