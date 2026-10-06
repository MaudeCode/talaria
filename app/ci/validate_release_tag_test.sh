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
printf 'release fixture\n' > "$repo/release-fixture.txt"
git -C "$repo" add .
git -C "$repo" commit -m "Release fixture" >/dev/null
git -C "$repo" push origin main >/dev/null
git -C "$repo" tag -a -m "Release fixture" app-v1.6.0

(
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  export GITHUB_REPOSITORY=synthetic/release
  local_tag_sha="$(git rev-parse 'refs/tags/app-v1.6.0^{tag}')"
  gh() {
    if [[ "$*" == *"/git/ref/tags/app-v1.6.0"* ]]; then
      printf '{"object":{"type":"tag","sha":"%s"}}\n' "$local_tag_sha"
    else
      printf '%s\n' "${fixture_signature:-true}"
    fi
  }
  tag_signature_verified app-v1.6.0
  fixture_signature=false
  if tag_signature_verified app-v1.6.0; then
    echo "Expected an unverified signature to fail." >&2
    exit 1
  fi
)

if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  export GITHUB_REPOSITORY=synthetic/release
  gh() { printf '{"object":{"type":"tag","sha":"0000000000000000000000000000000000000000"}}\n'; }
  tag_signature_verified app-v1.6.0 >/dev/null 2>&1
); then
  echo "Expected a moved remote tag object to fail verification." >&2
  exit 1
fi

(
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_TAG=app-v1.6.0
  export EXPECTED_SHA="$(git rev-parse HEAD)"
  validate_release_tag >/dev/null
)

# A tag that moved off the expected release commit, an unsigned lightweight tag and an unknown
# component never verify, even when GitHub would vouch for the signature.
git -C "$repo" tag app-v1.6.1
for rejected in "app app-v1.6.0 0000000000000000000000000000000000000000 resolves to" \
  "app app-v1.6.1 - must be an annotated signed tag" "desktop desktop-v1.6.0 - Unknown release component"; do
  read -r component tag expected message <<< "$rejected"
  if output="$(
    cd "$repo"
    source "$source_root/ci/validate_release_tag"
    tag_signature_verified() { return 0; }
    export RELEASE_COMPONENT="$component" RELEASE_TAG="$tag"
    [[ "$expected" == - ]] || export EXPECTED_SHA="$expected"
    validate_release_tag 2>&1
  )"; then
    echo "Expected ${tag} to fail: ${message}" >&2
    exit 1
  fi
  [[ "$output" == *"$message"* ]] || { echo "Expected '${message}' for ${tag}, got: ${output}" >&2; exit 1; }
done

git -C "$repo" tag -a -m "Bad version" app-v1.6
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_TAG=app-v1.6
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected malformed release tag to fail." >&2
  exit 1
fi

for component in web relay; do
  git -C "$repo" tag -a -m "Component fixture" "${component}-v1.6.0"
  (
    cd "$repo"
    source "$source_root/ci/validate_release_tag"
    tag_signature_verified() { return 0; }
    export RELEASE_COMPONENT="$component" RELEASE_TAG="${component}-v1.6.0"
    validate_release_tag >/dev/null
  )
done

git -C "$repo" tag -a -m "Experimental fixture" web-exp-v1.6.0
(
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_COMPONENT=web RELEASE_TAG=web-exp-v1.6.0
  validate_release_tag >/dev/null
)

for rejected_tag in v1.6.0 exp-v1.6.0 web-v1.6.0 relay-v1.6.0 app-v01.6.0; do
  if (
    cd "$repo"
    source "$source_root/ci/validate_release_tag"
    tag_signature_verified() { return 0; }
    export RELEASE_COMPONENT=app RELEASE_TAG="$rejected_tag"
    validate_release_tag >/dev/null 2>&1
  ); then
    echo "Expected historical, wrong-component or malformed tag to fail: $rejected_tag" >&2
    exit 1
  fi
done

# One-step releases (TAL-336): a signed root tag v<version> authorizes CI-created component tags at its commit.
git -C "$repo" tag -a -m "Root fixture" v1.8.0
git -C "$repo" tag -a -m "CI component fixture" app-v1.8.0
git -C "$repo" tag -a -m "CI component fixture" web-v1.8.0
signed_root_only() { [[ "$1" == v1.8.0 ]]; }
for component in app web; do
  (
    cd "$repo"
    source "$source_root/ci/validate_release_tag"
    tag_signature_verified() { signed_root_only "$1"; }
    export RELEASE_COMPONENT="$component" RELEASE_TAG="${component}-v1.8.0" EXPECTED_SHA="$(git rev-parse HEAD)"
    validate_release_tag >/dev/null
  )
done
(
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { signed_root_only "$1"; }
  export RELEASE_COMPONENT=release RELEASE_TAG=v1.8.0
  validate_release_tag >/dev/null
)
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 1; }
  export RELEASE_COMPONENT=app RELEASE_TAG=app-v1.8.0
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected a component tag without a signed root tag to fail." >&2
  exit 1
fi
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 1; }
  export RELEASE_COMPONENT=release RELEASE_TAG=v1.8.0
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected an unsigned root tag to fail." >&2
  exit 1
fi
printf 'next\n' >> "$repo/release-fixture.txt"
git -C "$repo" commit -qam "Next fixture"
git -C "$repo" push -q origin main
git -C "$repo" tag -a -m "Component at another commit" relay-v1.8.0
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { signed_root_only "$1"; }
  export RELEASE_COMPONENT=relay RELEASE_TAG=relay-v1.8.0
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected a component tag at a different commit from its root tag to fail." >&2
  exit 1
fi

git -C "$repo" switch -c side >/dev/null
printf 'off-main\n' >> "$repo/release-fixture.txt"
git -C "$repo" add .
git -C "$repo" commit -m "Off-main fixture" >/dev/null
git -C "$repo" tag -a -m "Off-main fixture" app-v1.7.0
if (
  cd "$repo"
  source "$source_root/ci/validate_release_tag"
  tag_signature_verified() { return 0; }
  export RELEASE_TAG=app-v1.7.0
  unset EXPECTED_SHA
  validate_release_tag >/dev/null 2>&1
); then
  echo "Expected off-main release tag to fail." >&2
  exit 1
fi

echo "validate_release_tag tests passed."
