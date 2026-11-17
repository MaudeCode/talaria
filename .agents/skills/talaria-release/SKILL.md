---
name: talaria-release
description: Publish a Talaria release (Relay, Web, App to TestFlight, release-set manifest) when the user requests one. One dispatch of the Release workflow (production-cutover.yml) on main with a vX.Y.Z version builds, publishes and tags last.
---

# Talaria release

Run release orchestration from the repository root. Read
[`releases/README.md`](../../../releases/README.md) for the request format,
workflow jobs, environment boundaries and partial-failure handling.

Release in one step: dispatch, then watch. No tag is pushed by hand.

1. Pick the version (one for the whole release; it must come after every
   existing `vX.Y.Z` tag and exceed every component's published version).
2. Dispatch it: the GitHub Scheduler's Releases page, or
   `gh workflow run production-cutover.yml --repo MaudeCode/talaria --ref main -f tag=vX.Y.Z`
   (add `-f sha=<commit>` to refuse the run if `main` has moved past it).
3. Watch the run titled `Release vX.Y.Z`. Report Relay readback, Web digest
   publication, App archive/upload/processing, the completed root manifest and
   the `tag` job separately; the version is released only once `vX.Y.Z` exists.
4. A run that failed before `publish-set` left no version tag: fix the cause and
   dispatch the same version again. One that published anything is partial:
   inspect its side effects, re-run its failed jobs or use the recovery
   workflow, and ship a code fix as the next patch version.

[`app/TESTFLIGHT.md`](../../../app/TESTFLIGHT.md) owns the App-specific gates:
build numbers, the closed-train preflight, App recovery, credentials and the
owner actions in App Store Connect (agreements, compliance, external testers,
Beta App Review).
