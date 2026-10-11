#!/usr/bin/env bash
# Assertions for the ci/*_test.sh suites. macOS bash 3.2 does not exit on a failed [[ ]] under set -e, so a bare
# [[ ]] assertion passed whatever it checked (TAL-752). Each of these exits on its own and says what it expected.
# Source it: source "$(dirname "$0")/test_assertions.sh"

# Usage: expect_eq ACTUAL EXPECTED
expect_eq() {
  [[ "$1" == "$2" ]] || { printf "Expected '%s', got '%s'\n" "$2" "$1" >&2; exit 1; }
}

# Usage: expect_glob ACTUAL PATTERN (a shell glob, such as '*text*')
expect_glob() {
  # shellcheck disable=SC2053 # The unquoted pattern is the glob.
  [[ "$1" == $2 ]] || { printf "Expected '%s' to match %s\n" "$1" "$2" >&2; exit 1; }
}

# Usage: expect_regex ACTUAL REGEX (extended)
expect_regex() {
  [[ "$1" =~ $2 ]] || { printf "Expected '%s' to match /%s/\n" "$1" "$2" >&2; exit 1; }
}
