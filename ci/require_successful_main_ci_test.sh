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

echo "require_successful_main_ci tests passed."
