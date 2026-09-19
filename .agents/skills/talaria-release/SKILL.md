---
name: talaria-release
description: Publish Talaria to TestFlight from a signed semantic tag when the user requests a versioned release or authorizes a release tag.
---

Run app commands from `app/`; unqualified source and tooling paths are relative
to `app/`. GitHub workflows and shared contract documentation remain at the root.

# Talaria release

Pushing a signed `vX.Y.Z` tag starts the TestFlight release workflow. The tag
push is the publish boundary and requires explicit user authorization.

1. Confirm `main` is clean, equals current `origin/main`, has successful exact-SHA
   CI, and the requested `X.Y.Z` tag does not exist.
2. After the user authorizes the tag push, create and push it:

   ```zsh
   git tag -s vX.Y.Z -m "Talaria vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. Watch `.github/workflows/release.yml` through completion. Report archive,
   upload, and App Store Connect processing separately.

GitHub Actions derives the marketing version from the tag and selects the next
App Store Connect-safe build number using environment secrets. Repository version
fields remain development defaults. The workflow uploads one external-capable
build that can also serve internal testers; tester assignment, Beta App Review,
agreements, and compliance prompts remain owner actions in App Store Connect.
