#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/require_successful_main_ci"

export GITHUB_REPOSITORY="MaudeCode/talaria"
export GITHUB_SHA="0123456789abcdef"

gh() {
  [[ "$*" == *"--repo MaudeCode/talaria"* ]]
  [[ "$*" == *"--workflow pr-ci.yml"* ]]
  [[ "$*" == *"--branch main"* ]]
  [[ "$*" == *"--commit 0123456789abcdef"* ]]
  [[ "$*" == *"--event push"* ]]
  [[ "$*" == *"--status success"* ]]
  printf '42\n'
}

[[ "$(require_successful_main_ci)" == "Verified successful CI run 42 for exact commit 0123456789abcdef." ]]

gh() { :; }
if require_successful_main_ci >/dev/null 2>&1; then
  echo "Expected a missing CI run to fail." >&2
  exit 1
fi

attempt_file="$(mktemp)"
trap 'rm -f "$attempt_file"' EXIT
printf '0\n' > "$attempt_file"
gh() {
  local attempts
  attempts="$(cat "$attempt_file")"
  attempts=$((attempts + 1))
  printf '%s\n' "$attempts" > "$attempt_file"
  [[ "$attempts" -ge 2 ]] && printf '84\n'
}
sleep() { :; }
# SECONDS ticks on wall-clock second boundaries, so a 1s budget can expire before the retry (TAL-380).
export WAIT_FOR_MAIN_CI_SECONDS=60
export MAIN_CI_POLL_SECONDS=0
[[ "$(require_successful_main_ci)" == *"Verified successful CI run 84"* ]]

echo "require_successful_main_ci tests passed."
