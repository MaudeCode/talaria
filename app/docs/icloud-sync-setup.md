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

## CloudKit Console (owner task, before any TestFlight or App Store build)

1. Open CloudKit Console → `iCloud.dev.kil.talaria` → **Development** schema.
2. Run a Debug build signed for a device, sign in with Apple in Settings →
   iCloud Sync, and enable sync. The first save creates the `TalariaConfiguration`
   zone and the `ServerSetup` / `AppPreferences` record types with `payload`
   as an **encrypted** Bytes field. Verify in the schema editor that `payload`
   shows as encrypted for both types. An encrypted field cannot be converted
   from a plaintext one later, so if it ever appears unencrypted, delete the
   record type in Development before retrying.
3. Confirm the records show no other fields and that record names are UUIDs.
4. **Deploy Schema Changes** to **Production**.
5. Install a production-signed build (TestFlight) on two iPhones signed into
   the same iCloud account with iCloud Keychain on, and confirm a
   password-authenticated server configured on one restores and signs in on the
   other.

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
