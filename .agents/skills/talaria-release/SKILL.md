---
name: talaria-release
description: Publish a Talaria release (Relay, Web, App to TestFlight, release-set manifest) when the user requests one. Pushing one signed vX.Y.Z tag on main starts the whole production release in CI.
---

# Talaria release

Run release orchestration from the repository root. Read
[`releases/README.md`](../../../releases/README.md) for the request format,
workflow dispatches, environment boundaries and partial-failure handling.

Release in one step: sign and push one tag, then watch.

1. Pick the version (one for the whole release; it must exceed every component's
   published version, and a version is used once).
2. `git tag -s vX.Y.Z <green main commit> -m "Talaria X.Y.Z" && git push origin vX.Y.Z`.
3. Watch the `Release` run (it tags the changed components and starts the
   production cutover on main) and then the `Production cutover` run. Report
   Relay readback, Web digest publication, App archive/upload/processing and
   the completed root manifest separately. A failed or partial run is
   incomplete; inspect its side effects before retrying. A fix that needs code
   ships as the next patch version.

[`app/TESTFLIGHT.md`](../../../app/TESTFLIGHT.md) owns the App-specific gates:
build numbers, the closed-train preflight, App recovery, credentials and the
owner actions in App Store Connect (agreements, compliance, external testers,
Beta App Review).
