#!/usr/bin/env bash
# ci/find-ui-suite-run and ci/ui-suite-due against a fake gh that replays synthetic run lists and a synthetic Git
# repository; never calls GitHub.
set -euo pipefail
# macOS bash 3.2 ignores a failed [[ ]] under set -e, so every check exits itself.

source_root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The scripts find scripts/changed-components.py from their own location, so they run from a copy in the synthetic
# repository, where it stays untracked and outside every diff.
repo="$work/repo"
mkdir -p "$work/bin" "$repo/app/ci" "$repo/scripts"
cp "$source_root"/app/ci/{find-ui-suite-run,ui-suite-due,gh-api-poll} "$repo/app/ci/"
cp "$source_root/scripts/changed-components.py" "$repo/scripts/"
script="$repo/app/ci/find-ui-suite-run"
due="$repo/app/ci/ui-suite-due"
# Each call runs the real jq filter over runs.json (the exact-commit query) or main.json (main's runs), unless a
# fail.N (this call) or fail (every call) file holds an error for it to print instead.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
count=$(( $(cat "$LOOKUP_TEST_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$LOOKUP_TEST_DIR/calls"
for failure in "$LOOKUP_TEST_DIR/fail.$count" "$LOOKUP_TEST_DIR/fail"; do
  [[ ! -f "$failure" ]] || { cat "$failure" >&2; exit 1; }
done
runs="$LOOKUP_TEST_DIR/main.json"
if [[ "$*" == *"repos/MaudeCode/talaria/actions/workflows/ui-suite.yml/runs?head_sha=${LOOKUP_SHA}&status=completed"* ]]; then
  runs="$LOOKUP_TEST_DIR/runs.json"
elif [[ "$*" != *"repos/MaudeCode/talaria/actions/workflows/ui-suite.yml/runs?branch=main&"* ]]; then
  echo "unexpected request: $*" >&2; exit 1
fi
filter=""
while (( $# )); do [[ "$1" == --jq ]] && filter="$2"; shift; done
jq -r "$filter" "$runs"
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
list() { local IFS=,; echo "{\"workflow_runs\":[$*]}"; }
runs() { rm -f "$work"/fail* "$work/calls"; list "$@" > "$work/runs.json"; list > "$work/main.json"; }
main_runs() { rm -f "$work/calls"; list "$@" > "$work/main.json"; }
fails() { if "$script" "$@" >/dev/null 2>&1; then echo "Expected find-ui-suite-run $* to fail." >&2; exit 1; fi; }

# A successful nightly or dispatch on exactly this SHA is reused; the newest match is printed once.
runs "$(run 3 "$sha" completed '"success"' schedule "UI suite on $sha")" "$(run 2 "$sha" completed '"success"' workflow_dispatch "UI suite on $sha")"
[[ "$("$script" "$sha")" == "https://github.com/MaudeCode/talaria/actions/runs/3" ]] || exit 1
[[ "$(cat "$work/calls")" == 1 ]] || exit 1
runs "$(run 2 "$sha" completed '"success"' workflow_dispatch "UI suite on $sha")"
[[ "$("$script" "$sha")" == "https://github.com/MaudeCode/talaria/actions/runs/2" ]] || exit 1

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
[[ -z "$output" ]] || exit 1
[[ "$(cat "$work/calls")" == 2 ]] || exit 1
runs
[[ -z "$("$script" "$sha")" ]] || exit 1

# A transient API error is retried; the answer after it counts.
runs "$(run 2 "$sha" completed '"success"' schedule "UI suite on $sha")"
echo "gh: Bad Gateway (HTTP 502)" > "$work/fail.1"
[[ "$("$script" "$sha" 2>/dev/null)" == "https://github.com/MaudeCode/talaria/actions/runs/2" ]] || exit 1
[[ "$(cat "$work/calls")" == 2 ]] || exit 1

# A lookup that cannot finish fails instead of reporting no run: a definitive HTTP error at once, transient errors
# after twelve tries.
for error in "gh: Not Found (HTTP 404)" "gh: Resource not accessible by integration (HTTP 403)" \
             'Get "https://api.github.com/...": net/http: TLS handshake timeout'; do
  runs "$(run 2 "$sha" completed '"success"' schedule "UI suite on $sha")"
  echo "$error" > "$work/fail"
  fails "$sha"
done
[[ "$(cat "$work/calls")" == 12 ]] || exit 1
# So does a failed lookup of main's runs after no exact match.
runs
echo "gh: Not Found (HTTP 404)" > "$work/fail.2"
fails "$sha"

# Only a full commit SHA is accepted.
runs "$(run 2 "$sha" completed '"success"' schedule "UI suite on $sha")"
for argument in "" main "${sha:0:12}" "${sha}0" "$(tr a A <<< "$sha")"; do fails "$argument"; done
[[ ! -f "$work/calls" ]] || exit 1

# A synthetic main: base, then a Web-only commit, then an App commit; a side commit is off main's history.
git -C "$repo" init -q -b main
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config user.name test
git -C "$repo" config commit.gpgsign false
commit() { # commit PATH MESSAGE
  mkdir -p "$repo/$(dirname "$1")"; echo "$2" >> "$repo/$1"
  git -C "$repo" add "$1"; git -C "$repo" commit -q -m "$2"; git -C "$repo" rev-parse HEAD
}
base=$(commit app/Talaria/View.swift base)
web=$(commit web/packages/frontend/page.ts web)
app=$(commit app/Talaria/View.swift app)
git -C "$repo" switch -q -c side "$base"
side=$(commit app/Talaria/Side.swift side)
git -C "$repo" switch -q main

# Without an exact match, a successful unscoped main run on an ancestor counts when only non-App commits followed it.
export LOOKUP_SHA="$web"
runs
main_runs "$(run 21 "$base" completed '"success"' schedule "UI suite on $base")"
[[ "$("$script" "$web")" == "https://github.com/MaudeCode/talaria/actions/runs/21" ]] || exit 1
# Not once an App commit followed it, nor for a commit off its history, a scoped run or another event.
export LOOKUP_SHA="$app"
runs
main_runs "$(run 21 "$base" completed '"success"' schedule "UI suite on $base")"
[[ -z "$("$script" "$app")" ]] || exit 1
main_runs "$(run 22 "$side" completed '"success"' workflow_dispatch "UI suite on $side")" \
          "$(run 23 "$web" completed '"success"' workflow_dispatch "UI suite (scoped) on $web")" \
          "$(run 24 "$web" completed '"success"' push "UI suite on $web")"
[[ -z "$("$script" "$app")" ]] || exit 1
# ci/ui-suite-due counts App-changing first-parent commits since the newest unscoped, uncancelled main run.
export LOOKUP_SHA="none"
is_due() { "$due" "$@" 2>/dev/null; }
main_runs "$(run 31 "$base" completed '"success"' schedule "UI suite on $base")"
[[ "$(is_due "$app" 1)" == due=true ]] || exit 1
[[ "$(is_due "$app" 2)" == due=false ]] || exit 1
# A merged branch counts once, through its merge commit; the Web-only commit never counts.
git -C "$repo" merge -q --no-ff -m merge side
merge=$(git -C "$repo" rev-parse HEAD)
[[ "$(is_due "$merge" 2)" == due=true ]] || exit 1
[[ "$(is_due "$merge" 3)" == due=false ]] || exit 1
[[ "$(is_due "$web" 1)" == due=false ]] || exit 1
# A queued, running or failed run resets the count; a cancelled or scoped one does not.
for state in 'queued null' 'in_progress null' 'completed "failure"'; do
  read -r status conclusion <<< "$state"
  main_runs "$(run 32 "$app" "$status" "$conclusion" workflow_dispatch "UI suite on $app")" \
            "$(run 31 "$base" completed '"success"' schedule "UI suite on $base")"
  [[ "$(is_due "$merge" 1)" == due=true && "$(is_due "$merge" 2)" == due=false ]] || exit 1
done
main_runs "$(run 33 "$app" completed '"cancelled"' workflow_dispatch "UI suite on $app")" \
          "$(run 34 "$app" completed '"success"' workflow_dispatch "UI suite (scoped) on $app")" \
          "$(run 31 "$base" completed '"success"' schedule "UI suite on $base")"
[[ "$(is_due "$merge" 2)" == due=true ]] || exit 1
# No run on main, or one off HEAD's history, is due at once.
main_runs
[[ "$(is_due "$web" 5)" == due=true ]] || exit 1
main_runs "$(run 35 "$other" completed '"success"' schedule "UI suite on $other")"
[[ "$(is_due "$web" 5)" == due=true ]] || exit 1
# A lookup failure fails instead of guessing.
main_runs
echo "gh: Not Found (HTTP 404)" > "$work/fail"
if "$due" "$web" 5 >/dev/null 2>&1; then echo "Expected ui-suite-due to fail." >&2; exit 1; fi
rm -f "$work/fail"

echo "find-ui-suite-run and ui-suite-due tests passed."
