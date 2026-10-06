# Releases and TestFlight

Run commands in this document from `app/`. Workflows live in `../.github/`.

> **Maintainer only.** This needs the maintainer's Apple Developer account, App
> Store Connect access and signing credentials. Contributors never need it.

## Release

A release is one signed `vX.Y.Z` tag on a green `main` commit; CI tags the
changed components, including `app-vX.Y.Z`, and runs the production cutover.
The [release procedure](../releases/README.md#root-workflow) owns the steps,
gates and partial-failure recovery, and `$talaria-release` is the agent runbook.

For the App:

- The tag supplies the marketing version; App Store Connect supplies the next
  build number. Repository version fields are development defaults.
- Once Apple approves a version for the App Store, it closes that version's
  TestFlight train and the run fails its preflight. Release the next version.
- One external-capable IPA (app, share extension, widget extension) serves
  internal and external testing.
- Release notes come from `../changelog.d/`; see
  [release-note authoring](docs/release-notes.md).
- If Relay and Web published but the App upload failed, rerun the failed job,
  or run `Recover failed cutover App publication` (`recover-cutover.yml`) within
  30 days to resume the same IPA. `Inspect existing TestFlight upload`
  (`inspect-testflight.yml`) reads a build's metadata without changing it.

## Credentials

The `testflight` environment holds `APP_STORE_CONNECT_KEY_ID`,
`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY`,
`IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64` and
`IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, and must allow the trusted `main`
workflow. The Apple Distribution identity belongs to team `Q28NF3NH3D`.

The Apple Developer portal needs the App IDs `dev.kil.talaria`,
`dev.kil.talaria.shareextension` and `dev.kil.talaria.liveactivitywidget`, the
App Group `group.dev.kil.talaria` on all three, and Sign in with
Apple plus iCloud on the app ([iCloud sync setup](docs/icloud-sync-setup.md)).
The Account Holder must accept each updated Apple Developer Program License
Agreement at <https://developer.apple.com/account>; TestFlight uploads and App
Store Connect API access stop until it is accepted.

## After upload

These are owner actions in App Store Connect:

1. Wait for processing and answer any compliance prompt. `Info.plist` declares
   `ITSAppUsesNonExemptEncryption = NO`.
2. Add the build to the internal group and check it on a physical iPhone:
   sign-in, chat streaming, sessions, attachments and share import, Kanban,
   Tasks, Git, Live Activities and widgets, and Relay and iCloud sync after
   Sign in with Apple.
3. For external testers, add the build to an external group and submit it for
   Beta App Review. Keep the review server URL and password in App Store Connect,
   never in git, and keep the server awake during review.

## Branch TestFlight builds

When the owner asks to **"push to branch testflight"**, upload the current
feature branch to the side-by-side Talaria Dev app (`Config/Dev.xcconfig`, see
DEVELOPMENT.md). This is a TestFlight upload, not a Git push; never touch the
production app unless asked. Talaria Dev uses bundle ID `dev.kil.talaria.branch` (extensions
`dev.kil.talaria.branch.shareextension` and
`dev.kil.talaria.branch.liveactivitywidget`), App Group
`group.dev.kil.talaria.branch`, URL scheme `talaria-branch`, display name
`Talaria Dev` and the DEV-banner icon.

1. Validate the branch: at least `git diff --check` and a simulator build.
2. Archive with a unique build number, for example `YYYYMMDDHHMM`:

   ```zsh
   xcodebuild -project Talaria.xcodeproj -scheme Talaria -configuration Release \
     -destination 'generic/platform=iOS' -archivePath build/TalariaBranch.xcarchive \
     -xcconfig Config/Dev.xcconfig CURRENT_PROJECT_VERSION=<unique-build-number> \
     archive -allowProvisioningUpdates
   ```

3. Upload:

   ```zsh
   xcodebuild -exportArchive -archivePath build/TalariaBranch.xcarchive \
     -exportOptionsPlist Config/BranchTestFlightExportOptions.plist \
     -exportPath build/TalariaBranchExport -allowProvisioningUpdates
   ```

4. Report the version and build number; App Store Connect needs time to process
   it before it reaches the phone.
