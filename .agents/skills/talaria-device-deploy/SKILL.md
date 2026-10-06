---
name: talaria-device-deploy
description: Deliver a Talaria build to a physical iPhone. Use for phone validation, publishing a branch build to DevApps, and USB or local Wi-Fi installs.
---

Run app commands from `app/`; unqualified source and tooling paths are relative
to `app/`. GitHub workflows and shared contract documentation remain at the root.

# Talaria physical-device delivery

Every phone build is **Talaria Dev** (`Config/Dev.xcconfig`, bundle ID
`dev.kil.talaria.branch`, DEV-banner icon). It installs beside the App Store and
TestFlight app with its own data and server setup. This workflow does not
authorize TestFlight uploads or changes to Apple Developer resources.

## Publish to DevApps (default)

DevApps is how builds reach the phone. Use it for every phone checkpoint unless
the user asks for a USB install:

```zsh
scripts/publish-devapps --ticket TAL-<n> --ticket-title '<exact Kaneo title>' \
  --title '<what this build changes>' --notes '<what to check; PR link>'
```

The script archives Talaria Dev, exports a `release-testing` IPA, refuses any
other bundle ID, and publishes it with the DEV-banner icon to the
`talaria-dev` app on <https://devapps.thezoo.house/apps/talaria-dev/>.
Arguments after the script go to the publisher; see `$devapps` for its fields and
its delivery verification. Keep the same `--ticket` across revisions so each new
build updates that ticket's row.

Done when the publisher returns a `versionUrl`. Give the user that link, tell
them to open it in Safari on the iPhone, and list what to check. Installation is
unconfirmed until the user reports it.

## Install over USB or local Wi-Fi

When the user asks for a direct install on a paired iPhone:

```zsh
scripts/run-ios-device --no-launch
```

The script discovers one paired physical iPhone, builds a signed Debug Talaria
Dev app, verifies its signature and bundle ID, and installs it. Add `--fresh` to
clear the local build cache (phone data is kept). Omit `--no-launch` only when
the user asks to open the app. If multiple iPhones are paired, set
`TALARIA_DEVICE_ID` to the hardware UDID or the CoreDevice identifier from
`xcrun devicectl list devices`.

Report build, signing, and install results separately when the script stops
partway through. If a requested launch reports a locked phone, the app is
installed; ask the user to unlock it, then rerun without `--fresh`.

Use `$talaria-ios-testing` for XCTest and simulator validation. Follow
[TESTFLIGHT.md](../../../app/TESTFLIGHT.md) for an explicitly requested TestFlight
workflow.
