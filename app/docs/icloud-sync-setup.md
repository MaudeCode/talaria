# iCloud sync setup (TAL-91)

Talaria syncs configured servers (URL, display identity, retained password,
custom headers, order) and an allowlisted set of app preferences through the
user's **private CloudKit database**. Sign in with Apple identifies the account
experience; CloudKit owns storage. Neither authenticates a Hermes WebUI server,
and Talaria has no sync backend of its own.

## What the code expects

| Item | Value | Where |
| --- | --- | --- |
| iCloud container | `iCloud.dev.kil.talaria` (`ICLOUD_CONTAINER_IDENTIFIER`, suffixed like the bundle id for branch builds) | `Config/Shared.xcconfig`, `Talaria/Resources/Talaria.entitlements`, `Info.plist` key `TalariaCloudKitContainerIdentifier` |
| Record zone | `TalariaConfiguration` in the private database | `CloudKitConfigurationSyncStore` |
| Record types | `ServerSetup`, `AppPreferences` | `ConfigurationSyncRecord.RecordType` |
| Fields | one `payload` (Bytes) written through `CKRecord.encryptedValues`; no other fields | `CloudKitConfigurationSyncStore.makeRecord` |

Record names are opaque UUIDs. The normalized server URL lives only inside the
encrypted payload, so record metadata never exposes a server. No query index is
needed: the app reads the zone as a change delta, which also carries deletions.

Only the main app target has the CloudKit entitlement. The share extension and
the Live Activity widget do not read synced records and must not gain access.

## Apple Developer portal (owner task, one time)

1. Certificates, Identifiers & Profiles → Identifiers → `dev.kil.talaria`
   (and `dev.kil.talaria.branch` if branch TestFlight builds should sync).
2. Capabilities: confirm **Sign in with Apple** is enabled with this App ID as
   the primary App ID. Do not create a Services ID, web domain, Sign in with
   Apple key, or server-to-server endpoint for this feature.
3. Enable **iCloud** with **CloudKit** and attach the container
   `iCloud.dev.kil.talaria` (create it under Identifiers → iCloud Containers
   if missing). Branch builds use `iCloud.dev.kil.talaria.branch`.
4. Regenerate every affected provisioning profile (development, ad hoc, and
   App Store) so it carries the iCloud capability, then update the repository's
   signing inputs through the normal secret-handling path (`TESTFLIGHT.md`).
   Xcode automatic signing regenerates development profiles on the next
   device build; the release workflow's manually signed profiles must be
   replaced by hand.

## CloudKit schema (owner task, before any release-signed build)

`docs/cloudkit-schema.ckdb` is the schema every Talaria container needs:
`ServerSetup` and `AppPreferences`, each with one `payload` field declared
`ENCRYPTED BYTES`. An encrypted field cannot be converted from a plaintext one
later. `ConfigurationSyncTests` fails when the app writes a record type this
file does not declare.

Release-signed builds (TestFlight, App Store, DevApps Talaria Dev) use the
**Production** environment, which cannot create record types at runtime. A
missing type fails with "Cannot create new type … in production schema".
Apply the schema to each container: `iCloud.dev.kil.talaria` and
`iCloud.dev.kil.talaria.branch` (Talaria Dev).

1. Save a management token once:
   `xcrun cktool save-token --type management` opens CloudKit Console; create
   the token under your account's Settings and paste it at the prompt. It is
   stored in the macOS Keychain.
2. Import into Development (cktool cannot write Production):

   ```zsh
   xcrun cktool import-schema --validate --team-id Q28NF3NH3D \
     --container-id iCloud.dev.kil.talaria.branch --environment development \
     --file docs/cloudkit-schema.ckdb
   ```

3. Deploy to Production: CloudKit Console → **CloudKit Database** → choose the
   container → **Deploy Schema Changes** → review → **Deploy**.
4. Confirm both environments match the file:
   `xcrun cktool export-schema --team-id Q28NF3NH3D --container-id <container> --environment production`.
5. Install a release-signed build on two devices signed into the same iCloud
   account with iCloud Keychain on, and confirm a password-authenticated server
   configured on one restores and signs in on the other.

## Local validation

```zsh
plutil -p Talaria/Resources/Talaria.entitlements
xcodebuild -showBuildSettings -project Talaria.xcodeproj -scheme Talaria -configuration Release \
  | rg "ICLOUD_CONTAINER_IDENTIFIER|CODE_SIGN_ENTITLEMENTS"
scripts/test-ios TalariaTests/ConfigurationSyncTests
```

Simulator builds are signed ad hoc and never contact CloudKit in tests; the
coordinator runs against an in-memory store. A build whose container id did not
resolve reports "This build has no iCloud container configured" in Settings and
writes nothing.

## Contributors with their own team

`Config/Local.xcconfig` can override `ICLOUD_CONTAINER_IDENTIFIER` to a
container on your team. Simulator-only development needs no change.

## Privacy copy

CloudKit encrypts `encryptedValues` on the device with key material from the
user's iCloud Keychain. Settings copy describes exactly that and does not claim
unconditional end-to-end encryption: whether the rest of the user's iCloud
data is end-to-end protected depends on Advanced Data Protection, which Talaria
does not control.
