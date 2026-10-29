#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/test_assertions.sh"

source "$(dirname "$0")/require_successful_main_ci"

export GITHUB_REPOSITORY="MaudeCode/talaria"
export GITHUB_SHA="0123456789abcdef"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A fake `gh run list` over runs.<poll>.json (or runs.json), newest first: it applies the --commit, --branch, --event,
# --status and --limit filters the way GitHub does, then the caller's real --jq filter. Never calls GitHub.
gh() {
  expect_glob "$*" 'run list *--repo MaudeCode/talaria*'
  expect_glob "$*" '*--workflow ci.yml*'
  local polls commit="" branch="" event="" status="" limit=20 filter="" data
  polls=$(( $(cat "$work/polls" 2>/dev/null || echo 0) + 1 ))
  echo "$polls" > "$work/polls"
  while (( $# )); do
    case "$1" in
      --commit) commit="$2" ;; --branch) branch="$2" ;; --event) event="$2" ;;
      --status) status="$2" ;; --limit) limit="$2" ;; --jq) filter="$2" ;;
    esac
    shift
  done
  data="$work/runs.$polls.json"
  [[ -f "$data" ]] || data="$work/runs.json"
  jq --arg commit "$commit" --arg branch "$branch" --arg event "$event" --arg status "$status" --argjson limit "$limit" '
    map(select(($commit == "" or .headSha == $commit) and ($branch == "" or .headBranch == $branch)
      and ($event == "" or .event == $event) and ($status == "" or .status == $status or .conclusion == $status)))
    | .[:$limit]' "$data" | jq -r "$filter"
}
sleep() { :; }

# run ID STATUS CONCLUSION [ATTEMPT] [HEAD_SHA] [EVENT]
run() {
  printf '{"databaseId":%s,"status":"%s","conclusion":"%s","attempt":%s,"headSha":"%s","headBranch":"main","event":"%s","url":"https://github.com/MaudeCode/talaria/actions/runs/%s"}' \
    "$1" "$2" "$3" "${4:-1}" "${5:-$GITHUB_SHA}" "${6:-push}" "$1"
}
# runs [POLL] RUN... writes the list one poll (or, without POLL, every poll) sees.
runs() {
  local file="$work/runs.json"
  [[ "${1:-}" == [0-9]* ]] && { file="$work/runs.$1.json"; shift; }
  local IFS=,
  echo "[$*]" > "$file"
}
reset() { rm -f "$work"/runs*.json "$work/polls"; }
polls() { cat "$work/polls"; }
export MAIN_CI_POLL_SECONDS=0

# A successful main-push run on the exact SHA passes on the first poll.
reset
runs "$(run 42 completed success)"
export WAIT_FOR_MAIN_CI_SECONDS=0
expect_eq "$(require_successful_main_ci)" "Verified successful CI run 42 for exact commit 0123456789abcdef."

# A completed, failed run fails on the first poll with its URL and the recovery, without waiting for the deadline.
reset
runs "$(run 40787758110 completed failure)"
export WAIT_FOR_MAIN_CI_SECONDS=60
if output="$(require_successful_main_ci 2>&1)"; then
  echo "Expected a failed main CI run to fail the wait." >&2
  exit 1
fi
expect_eq "$(polls)" 1
expect_glob "$output" '::error::*https://github.com/MaudeCode/talaria/actions/runs/40787758110*'
expect_glob "$output" '*gh run rerun 40787758110 --failed*'
expect_glob "$output" '*rerun this release run*'

# A cancelled run is a failed run too.
reset
runs "$(run 43 completed cancelled)"
if require_successful_main_ci >/dev/null 2>&1; then
  echo "Expected a cancelled main CI run to fail the wait." >&2
  exit 1
fi
expect_eq "$(polls)" 1

# An in-progress rerun attempt of a failed run keeps the wait going until that attempt succeeds.
reset
runs 1 "$(run 44 queued "" 2)"
runs 2 "$(run 44 in_progress "" 2)"
runs "$(run 44 completed success 2)"
# SECONDS ticks on wall-clock second boundaries, so a 1s budget can expire before the retry (TAL-380).
export WAIT_FOR_MAIN_CI_SECONDS=60
output="$(require_successful_main_ci)"
expect_glob "$output" '*Waiting for main CI run 44 (attempt 2, queued)*'
expect_glob "$output" '*Verified successful CI run 44 for exact commit 0123456789abcdef.'
expect_eq "$(polls)" 3

# No run yet: wait, then pass once one succeeds; fail at the deadline if none appears.
reset
runs 1
runs "$(run 45 completed success)"
expect_glob "$(require_successful_main_ci)" '*Verified successful CI run 45*'
reset
runs
export WAIT_FOR_MAIN_CI_SECONDS=0
if output="$(require_successful_main_ci 2>&1)"; then
  echo "Expected a missing CI run to fail." >&2
  exit 1
fi
expect_glob "$output" '*No successful main-push CI run found for exact commit 0123456789abcdef*'

# Runs on another SHA or from another event never count, even when they succeeded or failed.
reset
runs "$(run 46 completed failure 1 fedcba9876543210)" "$(run 47 completed failure 1 "$GITHUB_SHA" pull_request)" \
  "$(run 48 completed success 1 fedcba9876543210)" "$(run 49 completed success 1 "$GITHUB_SHA" pull_request)"
if output="$(require_successful_main_ci 2>&1)"; then
  echo "Expected runs on another SHA or event not to count." >&2
  exit 1
fi
expect_glob "$output" '*No successful main-push CI run found*'

echo "require_successful_main_ci tests passed."
