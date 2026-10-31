#!/usr/bin/env bash
# ci/background with synthetic commands; no runner.
set -euo pipefail
source "$(dirname "$0")/test_assertions.sh"

script="$(cd "$(dirname "$0")" && pwd)/background"
RUNNER_TEMP="$(mktemp -d)"
export RUNNER_TEMP
trap 'rm -rf "$RUNNER_TEMP"' EXIT

# The command runs detached with its own arguments; wait prints its log and passes its status on.
"$script" start passing bash -c 'sleep 1; echo "prepared $1"' _ "a simulator"
expect_eq "$(cat "$RUNNER_TEMP/passing.log" 2>/dev/null)" ""
expect_eq "$("$script" wait passing)" "prepared a simulator"

"$script" start failing bash -c 'echo broken; exit 3'
status=0
output=$("$script" wait failing) || status=$?
expect_eq "$status" 3
expect_eq "$output" "broken"

# A command killed before it recorded a status fails rather than waiting forever.
"$script" start killed sleep 30
kill -9 "$(cat "$RUNNER_TEMP/killed.pid")"
status=0
output=$("$script" wait killed 2>&1) || status=$?
expect_eq "$status" 1
expect_glob "$output" "*killed stopped without a result*"

status=0
"$script" bogus name 2>/dev/null || status=$?
expect_eq "$status" 64
echo "background: ok"
