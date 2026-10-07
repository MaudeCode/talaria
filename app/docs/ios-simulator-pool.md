# Shared iOS simulator pool

Oar, Talaria and future iOS projects share `iOS Test 1` through `iOS Test 6`.
These are disposable synthetic-test devices, not signed-in development phones.
The current local pool uses iPhone 17 Pro on iOS 27.0. CI does not use the pool:
its disposable GitHub-hosted runners select Xcode 27.1 through
`.github/actions/setup-xcode` and boot the image's own `iPhone 17` on the newest
installed runtime that SDK runs (`IOS_SIMULATOR_OS`; the image has no iOS 27.1
runtime yet) with `futureware-tech/simulator-action` (see
`.github/workflows/app-tests.yml`).

```sh
scripts/setup-ios-test-pool
scripts/test-ios
```

Setup fills missing slots and reuses the existing pool's runtime and model.
On a new machine it selects the newest available *released* iPhone runtime.
Prerelease runtimes are skipped, identified by Apple's seed build numbering
(`24A5408d` for the iOS 27 beta against `23E254a` for 26.4 and `24A94401` for the
released 27.1), so installing a beta SDK never silently changes what local runs
and CI test against. To move an existing pool to a newer runtime, run
`IOS_SIMULATOR_RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-27-1
scripts/setup-ios-test-pool --refresh`. Select any
runtime explicitly, including a beta, with
`IOS_SIMULATOR_RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-26-4`, and a model
with `IOS_SIMULATOR_DEVICE_TYPE`. When no available iPhone matches, selection
creates one on the newest matching runtime (the newest supported iPhone unless a
model is requested) instead of failing.
`IOS_SIMULATOR_POOL_SIZE` defaults to six. `--refresh` recreates the entire shared
pool and refuses to run while any pool device is leased or booted. Refresh affects
all adopting projects. It does not copy accounts or app data.

Layout tests on another model, such as iPhone Duo (iOS 27.1 or later), set
`IOS_SIMULATOR_DEVICE_TYPE` for the run. The pool then leases any available
simulator of that model, under the same lease, instead of an `iOS Test N` slot;
like an explicit ID, a non-pool device is never erased. Create one first if none
exists:

```sh
export IOS_SIMULATOR_DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-Duo
scripts/select-ios-simulator   # finds an iPhone Duo, or creates one on the newest runtime that supports it
scripts/test-ios TalariaUITests/ComposerChipUITests
```

Every consumer uses `/tmp/ios-simulator-pool-$EUID/pool.lock` for setup/admission
and `leases/<UDID>.lock` for the duration of a device session. Locks use macOS
`shlock` and the owning process PID. `IOS_SIMULATOR_ID` selects a specific device
under the same lease. A booted device is never taken over, even after an owner
crashes; inspect and stop its surviving workload before manually shutting it down.
Exit 75 means busy; exit 69 means no matching available device.

`IOS_SIMULATOR_POOL_DIR` is only for isolated synthetic tooling tests. Never point
two real consumers at different lock directories for the same devices. The old
app-specific pool-directory and size variables are no longer used. The existing
app-specific simulator-ID variable remains an alias in each test runner.

## Use from another iOS project

Copy `scripts/ios-simulator-pool`, `scripts/setup-ios-test-pool` and
`scripts/select-ios-simulator` into its `scripts` directory. These generic files
are intentionally vendored identically so checkouts and CI do not depend on a
sibling repository or a globally installed package. Keep the shared protocol
compatible when updating a copy. For a machine-wide command, optionally install
just the standalone helper with `install -m 755 scripts/ios-simulator-pool
~/.local/bin/ios-simulator-pool` after creating `~/.local/bin`. Setup still runs
from an adopting repository.

The standalone helper leases and boots a device, exports `IOS_SIMULATOR_ID`, runs
a command, and shuts down and releases the device when that command exits.
Pool devices (`iOS Test N`) are also erased on release so no test-host state
carries over; a device whose erase fails is quarantined until a later erase
succeeds, and an explicitly selected non-pool simulator is never erased:

```sh
scripts/ios-simulator-pool zsh -c '
  exec xcodebuild test -project Example.xcodeproj -scheme Example \
    -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_ID" \
    -derivedDataPath .codex-tmp/tests -parallel-testing-enabled NO
'
```

Use a foreground command that owns its children; do not detach work from the
lease. Existing shell runners may source the helper, call `ios_pool_acquire`,
and call `ios_pool_release` in their EXIT trap after stopping/waiting for their
child process. Preserve worktree-local build products and app-specific test
identities. Run `scripts/test-ios-simulator-pool` for the synthetic contract check.

## Migration

Update old worktrees before using the generic pool. Their old names and separate
locks do not participate in this protocol. Do not pass generic UDIDs to old
runners. Only retire legacy pool devices after their existing setup and lease
locks are acquired and they are confirmed shut down; never delete a normal or
active simulator. Pool size does not override a project's own concurrency cap.
