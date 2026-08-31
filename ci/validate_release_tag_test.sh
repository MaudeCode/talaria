#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/talaria-tag-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

remote="$test_root/remote.git"
repo="$test_root/repo"
git init --bare --initial-branch=main "$remote" >/dev/null
git clone "$remote" "$repo" >/dev/null 2>&1
git -C "$repo" config user.name "Tag Test"
git -C "$repo" config user.email "tag-test@example.invalid"
git -C "$repo" config commit.gpgSign false
git -C "$repo" config tag.gpgSign false
mkdir -p "$repo/Talaria.xcodeproj"
cat > "$repo/Talaria.xcodeproj/project.pbxproj" <<'PBXPROJ'
MARKETING_VERSION = 1.6.0;
CURRENT_PROJECT_VERSION = 9;
PBXPROJ
git -C "$repo" add .
git -C "$repo" commit -m "Release fixture" >/dev/null
git -C "$repo" push origin main >/dev/null
git -C "$repo" tag -a -m "Release fixture" v1.6.0

(
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  export GITHUB_REPOSITORY=synthetic/release
  local_tag_sha="$(git rev-parse 'refs/tags/v1.6.0^{tag}')"
  gh() {
    if [[ "$*" == *"/git/ref/tags/v1.6.0"* ]]; then
      printf '{"object":{"type":"tag","sha":"%s"}}\n' "$local_tag_sha"
    else
      printf 'true\n'
    fi
  }
  tag_signature_verified v1.6.0
)

if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  export GITHUB_REPOSITORY=synthetic/release
  gh() { printf '{"object":{"type":"tag","sha":"0000000000000000000000000000000000000000"}}\n'; }
  tag_signature_verified v1.6.0 >/dev/null 2>&1
); then
  echo "Expected a moved remote tag object to fail verification." >&2
  exit 1
fi

(
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_TAG=v1.6.0
  export EXPECTED_SHA="$(git rev-parse HEAD)"
  validate_release_tag >/dev/null
)

git -C "$repo" tag -a -m "Bad version" v1.6
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_TAG=v1.6
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected malformed release tag to fail." >&2
  exit 1
fi

git -C "$repo" switch -c side >/dev/null
sed -i.bak 's/1\.6\.0/1.7.0/' "$repo/Talaria.xcodeproj/project.pbxproj"
rm "$repo/Talaria.xcodeproj/project.pbxproj.bak"
git -C "$repo" add .
git -C "$repo" commit -m "Off-main fixture" >/dev/null
git -C "$repo" tag -a -m "Off-main fixture" v1.7.0
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_TAG=v1.7.0
  unset EXPECTED_SHA
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected off-main release tag to fail." >&2
  exit 1
fi

echo "validate_release_tag tests passed."
