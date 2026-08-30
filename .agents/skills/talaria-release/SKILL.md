---
name: talaria-release
description: Prepare and publish a Talaria TestFlight release from main when the user requests a versioned release or authorizes a release tag.
---

# Talaria release

Pushing a signed `vX.Y.Z` tag starts the TestFlight release workflow. Treat the
tag push as the publish boundary and require explicit user authorization for it.

1. Confirm `main` is clean and the requested semantic version is explicit.
   Load `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and
   `APP_STORE_CONNECT_KEY_PATH` from the maintainer's credential store without
   printing them. Stop at this external boundary if they are unavailable.
2. Run `scripts/prepare-release <version> --dry-run` and report the proposed
   marketing version and App Store Connect-safe build number.
3. After the user authorizes the tag push, run
   `scripts/prepare-release <version> --publish`. The command locks the shared
   repository, fetches current `origin/main`, updates every target, validates the
   release, creates the signed commit and tag, and pushes both atomically.
4. Watch `.github/workflows/release.yml` through completion. Report archive,
   upload, and App Store Connect processing separately.

The workflow uploads one external-capable build that can also serve internal
testers. Tester assignment, Beta App Review, agreements, and compliance prompts
remain owner actions in App Store Connect.
