#!/usr/bin/env bash
# ci/report-test-failures against a fake gh that records each status it is asked to post; never calls GitHub.
set -euo pipefail
# macOS bash 3.2 ignores a failed [[ ]] under set -e, so every check exits itself.

script="$(cd "$(dirname "$0")" && pwd)/report-test-failures"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$REPORT_TEST_DIR/posts"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" REPORT_TEST_DIR="$work" GITHUB_REPOSITORY=MaudeCode/talaria \
  GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=42
sha=$(printf 'a%.0s' {1..40})

# report LOG-LINES...: follows a log that gains these lines after it starts, then stops it the way the step does.
report() {
  : > "$work/posts"; : > "$work/log"
  "$script" "$work/log" "$sha" "UI suite failures (shard 2)" &
  local reporter=$!
  sleep 0.5
  printf '%s\n' "$@" >> "$work/log"
  sleep 1
  kill "$reporter"
  wait "$reporter" || { echo "report-test-failures did not stop cleanly" >&2; exit 1; }
}

# A passing log posts nothing.
report "Test Case '-[TalariaUITests.ChatUITests testSend]' started." \
       "Test Case '-[TalariaUITests.ChatUITests testSend]' passed (3.2 seconds)."
[[ ! -s "$work/posts" ]] || { echo "Expected no status for a passing log" >&2; exit 1; }

# Each failing test posts one failure status on the tested commit, numbered and naming the latest.
report "Test Case '-[TalariaUITests.WorkspaceLoadingUITests testChangesSheetAndFileBrowserLoadThenNavigate]' failed (113.6 seconds)." \
       "Test Case '-[TalariaUITests.ChatUITests testSend]' passed (3.2 seconds)." \
       "Test Case '-[TalariaUITests.QueuedMessagesChipUITests testSheet]' failed (40.1 seconds)."
[[ $(wc -l < "$work/posts" | tr -d ' ') == 2 ]] || { echo "Expected two statuses, got: $(cat "$work/posts")" >&2; exit 1; }
first=$(sed -n 1p "$work/posts")
[[ "$first" == *"repos/MaudeCode/talaria/statuses/$sha"* && "$first" == *"state=failure"* ]] || { echo "Bad post: $first" >&2; exit 1; }
[[ "$first" == *"context=UI suite failures (shard 2)"* && "$first" == *"target_url=https://github.com/MaudeCode/talaria/actions/runs/42"* ]] || { echo "Bad post: $first" >&2; exit 1; }
[[ "$first" == *"description=1 failed, latest WorkspaceLoadingUITests.testChangesSheetAndFileBrowserLoadThenNavigate"* ]] || { echo "Bad post: $first" >&2; exit 1; }
[[ "$(sed -n 2p "$work/posts")" == *"description=2 failed, latest QueuedMessagesChipUITests.testSheet"* ]] || { echo "Bad second post" >&2; exit 1; }

# Once a shard's tests passed, --passed replaces any earlier failure under the same context with success.
: > "$work/posts"
"$script" --passed "$sha" "UI suite failures (shard 2)"
post=$(cat "$work/posts")
[[ "$post" == *"statuses/$sha"* && "$post" == *"state=success"* && "$post" == *"context=UI suite failures (shard 2)"* ]] ||
  { echo "Bad passed post: $post" >&2; exit 1; }

# Stopping it leaves nothing following the log.
if pgrep -f "tail -n \+1 -F $work/log" > /dev/null; then echo "report-test-failures left its log follower running" >&2; exit 1; fi

echo "report-test-failures checks passed."
