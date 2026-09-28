#!/usr/bin/env bash
# ci/ci-simulator against a fake xcrun; never touches real simulators.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-simulator"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "--sdk iphonesimulator --show-sdk-version") echo 27.0 ;;
  "simctl list devices available --json") cat "$FAKE_DEVICES" ;;
  "simctl create "*) echo "$3|$4" >> "$FAKE_CREATED"; echo CREATED-UDID ;;
  *) echo "unexpected xcrun $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/xcrun"
export PATH="$work/bin:$PATH" FAKE_DEVICES="$work/devices.json" FAKE_CREATED="$work/created"
phone=com.apple.CoreSimulator.SimDeviceType.iPhone-17
cat > "$FAKE_DEVICES" <<EOF
{"devices": {
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [{"udid": "OLD-RUNTIME", "deviceTypeIdentifier": "$phone"}],
  "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
    {"udid": "OTHER-MODEL", "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
    {"udid": "PREINSTALLED", "deviceTypeIdentifier": "$phone"}]}}
EOF

# The image's own iPhone 17 on the SDK's runtime, not another model or runtime.
[[ "$("$script")" == PREINSTALLED ]]
[[ ! -e "$FAKE_CREATED" ]]
# fresh always creates on the SDK's runtime.
[[ "$("$script" fresh 2>/dev/null)" == CREATED-UDID ]]
[[ "$(cat "$FAKE_CREATED")" == "$phone|com.apple.CoreSimulator.SimRuntime.iOS-27-0" ]]
# An image without that device gets one created.
echo '{"devices": {}}' > "$FAKE_DEVICES"
[[ "$("$script" preinstalled 2>/dev/null)" == CREATED-UDID ]]
if "$script" pooled 2>/dev/null; then echo "Expected an unknown mode to fail." >&2; exit 1; fi

echo "ci-simulator tests passed."
