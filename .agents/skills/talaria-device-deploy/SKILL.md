---
name: talaria-device-deploy
description: Build, install, and launch Talaria on a connected physical iPhone. Use for physical-device builds, phone installs, phone launches, and fresh local device builds.
---

Run app commands from `app/`; unqualified source and tooling paths are relative
to `app/`. GitHub workflows and shared contract documentation remain at the root.

# Talaria physical-device deployment

Use this workflow only when the user asks to build, install, or launch Talaria on
a physical iPhone. It does not authorize TestFlight uploads or changes to Apple
Developer resources.

## Run

Use the repository script from the `app/` directory:

```zsh
scripts/run-ios-device
```

The default run reuses `.codex-tmp/device-build` for the fastest rebuild. When the
user asks for a fresh build, run:

```zsh
scripts/run-ios-device --fresh
```

`--fresh` clears the local device build cache. It preserves the app and its data
on the iPhone.

When the user asks to install without opening Talaria, run:

```zsh
scripts/run-ios-device --no-launch
```

The script discovers one paired physical iPhone, builds a signed Debug app,
verifies its signature, and installs it. It launches the app unless `--no-launch`
is set. Discovery retries briefly while CoreDevice settles, then falls back to the
single paired iPhone in the unfiltered device record. If multiple iPhones are
paired, set `TALARIA_DEVICE_ID` to either the hardware UDID or the CoreDevice
identifier reported by `xcrun devicectl list devices`.

## Completion

- Success means the signed build was installed and, unless `--no-launch` was set,
  launched on the requested iPhone.
- If installation succeeds but launch reports a locked phone, say that the app is
  installed. Ask the user to unlock the phone, then rerun without `--fresh` so the
  cached build is reused.
- Report the build, signing, install, and launch result separately when the script
  stops partway through.

Use `$talaria-ios-testing` for XCTest and simulator validation. Follow
[TESTFLIGHT.md](../../../app/TESTFLIGHT.md) for an explicitly requested TestFlight
workflow.
