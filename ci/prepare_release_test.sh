#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/talaria-release-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

remote="$test_root/remote.git"
seed="$test_root/seed"
git init --bare --initial-branch=main "$remote" >/dev/null
git clone "$remote" "$seed" >/dev/null 2>&1
mkdir -p "$seed/Talaria.xcodeproj" "$seed/scripts"

cat > "$seed/Talaria.xcodeproj/project.pbxproj" <<'PBXPROJ'
MARKETING_VERSION = 1.5;
CURRENT_PROJECT_VERSION = 7;
MARKETING_VERSION = 1.5;
CURRENT_PROJECT_VERSION = 7;
PBXPROJ
cat > "$seed/scripts/validate-release" <<'VALIDATE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$TALARIA_RELEASE_VERSION" == "1.6.0" ]]
[[ "$TALARIA_RELEASE_BUILD" == "9" ]]
VALIDATE
chmod +x "$seed/scripts/validate-release"

git -C "$seed" config user.name "Release Test"
git -C "$seed" config user.email "release-test@example.invalid"
git -C "$seed" add .
git -C "$seed" commit -m "Initial fixture" >/dev/null
git -C "$seed" push origin main >/dev/null
initial_head="$(git -C "$seed" rev-parse HEAD)"

signing_key="$test_root/signing-key"
ssh-keygen -q -t ed25519 -N '' -f "$signing_key"

configure_clone() {
  local clone="$1"
  git -C "$clone" config user.name "Release Test"
  git -C "$clone" config user.email "release-test@example.invalid"
  git -C "$clone" config gpg.format ssh
  git -C "$clone" config user.signingkey "$signing_key"
  git -C "$clone" config commit.gpgsign true
  git -C "$clone" config tag.gpgSign true
}

git clone "$remote" "$test_root/dry-run" >/dev/null 2>&1
configure_clone "$test_root/dry-run"
before="$(git -C "$test_root/dry-run" status --porcelain=v1)"
(
  cd "$test_root/dry-run"
  "$source_root/scripts/prepare-release" 1.6.0 --dry-run --latest-app-store-build 8 >/dev/null
)
[[ "$(git -C "$test_root/dry-run" status --porcelain=v1)" == "$before" ]]
[[ "$(git -C "$test_root/dry-run" rev-parse HEAD)" == "$initial_head" ]]
if (
  cd "$test_root/dry-run"
  "$source_root/scripts/prepare-release" 1.6.0 --publish --latest-app-store-build 8 >/dev/null 2>&1
); then
  echo "Expected an offline build override to reject publishing." >&2
  exit 1
fi
[[ -z "$(git -C "$test_root/dry-run" status --porcelain=v1)" ]]

for racer in one two; do
  git clone "$remote" "$test_root/$racer" >/dev/null 2>&1
  configure_clone "$test_root/$racer"
done

set +e
(
  cd "$test_root/one"
  TALARIA_RELEASE_TEST_MODE=1 "$source_root/scripts/prepare-release" 1.6.0 --publish --latest-app-store-build 8 >"$test_root/one.log" 2>&1
  echo $? > "$test_root/one.status"
) &
one_pid=$!
(
  cd "$test_root/two"
  TALARIA_RELEASE_TEST_MODE=1 "$source_root/scripts/prepare-release" 1.6.0 --publish --latest-app-store-build 8 >"$test_root/two.log" 2>&1
  echo $? > "$test_root/two.status"
) &
two_pid=$!
wait "$one_pid"
wait "$two_pid"
set -e

one_status="$(cat "$test_root/one.status")"
two_status="$(cat "$test_root/two.status")"
[[ $((one_status + two_status)) -eq 1 ]]

[[ "$(git --git-dir="$remote" for-each-ref --format='%(objecttype)' refs/tags/v1.6.0)" == "tag" ]]
[[ "$(git --git-dir="$remote" show main:Talaria.xcodeproj/project.pbxproj | grep -c 'MARKETING_VERSION = 1.6.0;')" -eq 2 ]]
[[ "$(git --git-dir="$remote" show main:Talaria.xcodeproj/project.pbxproj | grep -c 'CURRENT_PROJECT_VERSION = 9;')" -eq 2 ]]

loser="one"
[[ "$one_status" -eq 1 ]] || loser="two"
[[ "$(git -C "$test_root/$loser" rev-parse HEAD)" == "$initial_head" ]]
[[ -z "$(git -C "$test_root/$loser" status --porcelain=v1)" ]]

echo "prepare-release concurrency tests passed."
