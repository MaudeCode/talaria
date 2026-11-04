#!/usr/bin/env bash
# ci/check-swift-warnings against synthetic xcodebuild logs.
set -euo pipefail
source "$(dirname "$0")/test_assertions.sh"

script="$(cd "$(dirname "$0")" && pwd)/check-swift-warnings"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
isolation="warning: call to main actor-isolated instance method 'apply' in a synchronous nonisolated context [#ActorIsolatedCall]"

# check LOG-LINES...: sets status and output from a run over a log of these lines.
check() {
  printf '%s\n' "$@" > "$work/log"
  status=0
  output=$("$script" "$work/log" 2>&1) || status=$?
}

check "/runner/talaria/app/DerivedData/SourcePackages/checkouts/swift-cmark/Package.swift: warning: DEFINES_MODULE was set" \
      "/runner/talaria/app/DerivedData/SourcePackages/checkouts/Splash/Sources/Token.swift:3:1: warning: var is unused" \
      "ld: warning: ignoring duplicate libraries" \
      "** TEST BUILD SUCCEEDED **"
expect_eq "$status" 0
expect_eq "$output" ""

check "/runner/talaria/app/Talaria/Features/Chat/Paste.swift:11:17: $isolation" \
      "/runner/talaria/app/Talaria/Features/Chat/Paste.swift:11:17: $isolation" \
      "/runner/talaria/app/TalariaKit/Sources/TalariaKit/Models/Cron.swift:2:1: warning: var is unused" \
      "** TEST BUILD SUCCEEDED **"
expect_eq "$status" 1
expect_eq "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" 2
expect_glob "$output" "*error: Swift warning: /runner/talaria/app/Talaria/Features/Chat/Paste.swift:11:17: warning: call to main actor*"
expect_glob "$output" "*error: Swift warning: /runner/talaria/app/TalariaKit/Sources/TalariaKit/Models/Cron.swift:2:1:*"
