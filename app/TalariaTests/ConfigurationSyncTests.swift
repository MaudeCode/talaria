import CloudKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Sign in with Apple + CloudKit configuration sync (TAL-91). Every test runs
/// against an in-memory sync store, in-memory Keychains, and throwaway
/// UserDefaults suites; nothing touches CloudKit, the real Keychain, or
/// `.standard`.
@MainActor
final class ConfigurationSyncTests: XCTestCase {
    private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)
    private let serverA = "https://alpha.example.test"
    private let serverB = "https://beta.example.test"

    // MARK: - Payload and record shape

    func testServerSetupPayloadDecodesOlderShapeTolerantly() throws {
        let json = #"{"urlString":"https://old.example.test","displayName":"Old"}"#
        let setup = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: Data(json.utf8))

        XCTAssertEqual(setup.urlString, "https://old.example.test")
        XCTAssertEqual(setup.displayName, "Old")
        XCTAssertNil(setup.password)
        XCTAssertEqual(setup.customHeaders, [])
        XCTAssertEqual(setup.version, 1)
    }

    func testFingerprintIgnoresTimestampButNotContent() {
        var setup = makeSetup(url: serverA, password: "pw", updatedAt: fixedNow)
        let original = setup.fingerprint
        setup.updatedAt = fixedNow.addingTimeInterval(60)
        XCTAssertEqual(setup.fingerprint, original)
        setup.password = "other"
        XCTAssertNotEqual(setup.fingerprint, original)
    }

    func testCloudKitRecordCarriesPayloadOnlyInEncryptedValues() throws {
        let setup = makeSetup(
            url: serverA,
            password: "top-secret",
            headers: [CustomHeader(name: "X-Proxy-Token", value: "proxy-secret")],
            updatedAt: fixedNow
        )
        let record = try ConfigurationSyncRecord.serverSetup(name: UUID().uuidString, setup)

        let ckRecord = CloudKitConfigurationSyncStore.makeRecord(record)

        XCTAssertEqual(ckRecord.recordType, "ServerSetup")
        XCTAssertEqual(ckRecord.recordID.zoneID.zoneName, CloudKitConfigurationSyncStore.zoneName)
        // `allKeys()` lists encrypted keys too; the plain accessor must see none of them.
        for key in ckRecord.allKeys() {
            XCTAssertNil(ckRecord[key], "Plain field \(key) must not exist")
        }
        XCTAssertEqual(ckRecord.encryptedValues.allKeys(), [CloudKitConfigurationSyncStore.payloadKey])
        XCTAssertEqual(ckRecord.encryptedValues[CloudKitConfigurationSyncStore.payloadKey] as? Data, record.payload)
        XCTAssertNotNil(UUID(uuidString: ckRecord.recordID.recordName), "Record names must be opaque.")
        for secret in ["alpha.example.test", "top-secret", "proxy-secret", "X-Proxy-Token"] {
            XCTAssertFalse(ckRecord.recordID.recordName.contains(secret))
            XCTAssertFalse(ckRecord.description.contains(secret), "Plain record description leaks \(secret)")
        }
        XCTAssertEqual(CloudKitConfigurationSyncStore.syncRecord(from: ckRecord), record)
    }

    // MARK: - Merge

    func testMergeRemoteNewerWinsAndInheritsLocalPassword() {
        let local = makeSetup(url: serverA, name: "Local", password: "pw", updatedAt: fixedNow)
        let remote = makeSetup(url: serverA, name: "Remote", password: nil, updatedAt: fixedNow.addingTimeInterval(10))
        var state = ConfigurationSyncState()
        state.recordNames[serverA] = "rec-a"

        let plan = ConfigurationSyncMerge.plan(
            local: [local],
            remote: [.init(recordName: "rec-a", setup: remote)],
            remoteDeletions: [],
            state: state,
            now: fixedNow.addingTimeInterval(20)
        )

        XCTAssertEqual(plan.applyLocally.map(\.displayName), ["Remote"])
        XCTAssertEqual(plan.applyLocally.first?.password, "pw")
        // The winner gained the local password, so it goes back up once.
        XCTAssertEqual(plan.upload.map(\.setup.password), ["pw"])
        XCTAssertEqual(plan.removeLocally, [])
    }

    func testMergeLocalNewerUploadsAndKeepsLocal() {
        let local = makeSetup(url: serverA, name: "Local", password: "pw", updatedAt: fixedNow.addingTimeInterval(10))
        let remote = makeSetup(url: serverA, name: "Remote", password: "pw", updatedAt: fixedNow)
        var state = ConfigurationSyncState()
        state.recordNames[serverA] = "rec-a"
        state.uploaded[serverA] = .init(fingerprint: local.fingerprint, changedAt: local.updatedAt)

        let plan = ConfigurationSyncMerge.plan(
            local: [local],
            remote: [.init(recordName: "rec-a", setup: remote)],
            remoteDeletions: [],
            state: state,
            now: fixedNow.addingTimeInterval(20)
        )

        XCTAssertTrue(plan.applyLocally.isEmpty)
        XCTAssertEqual(plan.upload.map(\.setup.displayName), ["Local"])
        XCTAssertEqual(plan.upload.first?.recordName, "rec-a")
    }

    func testMergeRemoteDeletionRemovesLocalAndLocalRemovalDeletesRemote() {
        let local = makeSetup(url: serverA, password: "pw", updatedAt: fixedNow)
        var state = ConfigurationSyncState()
        state.recordNames = [serverA: "rec-a", serverB: "rec-b"]

        let plan = ConfigurationSyncMerge.plan(
            local: [local],
            remote: [],
            remoteDeletions: ["rec-a"],
            state: state,
            now: fixedNow
        )

        XCTAssertEqual(plan.removeLocally, [serverA])
        XCTAssertEqual(plan.deleteRemote, ["rec-b"])
        XCTAssertEqual(plan.recordNames, [:])
        XCTAssertTrue(plan.upload.isEmpty)
    }

    func testMergeCollapsesDuplicateRecordsForOneServer() {
        let mine = makeSetup(url: serverA, name: "Mine", password: "pw", updatedAt: fixedNow)
        let theirs = makeSetup(url: serverA, name: "Theirs", password: "pw", updatedAt: fixedNow.addingTimeInterval(5))
        var state = ConfigurationSyncState()
        state.recordNames[serverA] = "rec-z"

        let plan = ConfigurationSyncMerge.plan(
            local: [mine],
            remote: [.init(recordName: "rec-a", setup: theirs)],
            remoteDeletions: [],
            state: state,
            now: fixedNow.addingTimeInterval(10)
        )

        XCTAssertEqual(plan.recordNames[serverA], "rec-a")
        XCTAssertEqual(plan.deleteRemote, ["rec-z"])
        XCTAssertEqual(plan.applyLocally.map(\.displayName), ["Theirs"])
        XCTAssertEqual(plan.order, [serverA])
    }

    func testMergeUploadsNewerDuplicateUnderCanonicalNameBeforeDeletingIt() {
        // The canonical name sorts first, but the newer payload arrived under the
        // duplicate that is about to be deleted: it must move to the canonical record.
        let mine = makeSetup(url: serverA, name: "Mine", password: "pw", updatedAt: fixedNow)
        let theirs = makeSetup(url: serverA, name: "Theirs", password: "pw", updatedAt: fixedNow.addingTimeInterval(5))
        var state = ConfigurationSyncState()
        state.recordNames[serverA] = "rec-a"
        state.uploaded[serverA] = .init(fingerprint: mine.fingerprint, changedAt: mine.updatedAt)

        let plan = ConfigurationSyncMerge.plan(
            local: [mine],
            remote: [.init(recordName: "rec-z", setup: theirs)],
            remoteDeletions: [],
            state: state,
            now: fixedNow.addingTimeInterval(10)
        )

        XCTAssertEqual(plan.recordNames[serverA], "rec-a")
        XCTAssertEqual(plan.deleteRemote, ["rec-z"])
        XCTAssertEqual(plan.applyLocally.map(\.displayName), ["Theirs"])
        XCTAssertEqual(plan.upload.map { ($0.recordName, $0.setup.displayName) }.map { "\($0.0):\($0.1)" }, ["rec-a:Theirs"])
    }

    func testMergeAppliesOnlyTheFinalWinnerWhenSeveralDuplicatesArrive() {
        let older = makeSetup(url: serverA, name: "Older", password: "pw", updatedAt: fixedNow)
        var newer = makeSetup(url: serverA, name: "Newer", password: "pw", updatedAt: fixedNow.addingTimeInterval(5))
        newer.position = 0
        var olderLate = older
        olderLate.position = 3

        let plan = ConfigurationSyncMerge.plan(
            local: [],
            remote: [.init(recordName: "rec-a", setup: olderLate), .init(recordName: "rec-z", setup: newer)],
            remoteDeletions: [],
            state: ConfigurationSyncState(),
            now: fixedNow.addingTimeInterval(10)
        )

        XCTAssertEqual(plan.applyLocally.map(\.displayName), ["Newer"])
        XCTAssertEqual(plan.deleteRemote, ["rec-z"])
        XCTAssertEqual(plan.upload.map { "\($0.recordName):\($0.setup.displayName)" }, ["rec-a:Newer"])
    }

    func testMergeAssignsOpaqueNamesToNewLocalServers() {
        let local = makeSetup(url: serverA, password: "pw", updatedAt: fixedNow)

        let plan = ConfigurationSyncMerge.plan(
            local: [local],
            remote: [],
            remoteDeletions: [],
            state: ConfigurationSyncState(),
            now: fixedNow,
            makeRecordName: { "fresh-record" }
        )

        XCTAssertEqual(plan.upload.map(\.recordName), ["fresh-record"])
        XCTAssertEqual(plan.recordNames, [serverA: "fresh-record"])
    }

    // MARK: - Retained passwords

    func testPasswordLoginRetainsPasswordScopedToServer() async throws {
        let device = try await makeDevice()
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")

        XCTAssertEqual(device.keychain.scopedValue(.serverPassword, scope: serverA), "pw-a")
        XCTAssertEqual(device.authManager.serverPassword(for: serverA), "pw-a")
        XCTAssertNil(device.keychain.savedValues[.serverPassword], "Never stored under a global key.")
    }

    func testServerWithoutAuthIsRecordedAsNeedingNoPassword() async throws {
        let device = try await makeDevice(
            client: MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false, loggedIn: false))
        )
        await device.authManager.configure(serverURLString: serverA, password: "")

        XCTAssertEqual(device.authManager.serverPassword(for: serverA), AuthManager.noPasswordRequired)
    }

    func testLoginFailsWhenThePasswordCannotBeRetained() async throws {
        let device = try await makeDevice()
        device.keychain.saveErrors[.serverPassword] = URLError(.cannotWriteToFile)

        await device.authManager.configure(serverURLString: serverA, password: "pw-a")

        XCTAssertEqual(device.authManager.state, .unconfigured)
        XCTAssertTrue(device.authManager.servers.isEmpty)
        XCTAssertNotNil(device.authManager.lastErrorMessage)
    }

    func testSignOutRemovesRetainedPassword() async throws {
        let device = try await makeDevice()
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")

        await device.authManager.signOut()

        XCTAssertNil(device.authManager.serverPassword(for: serverA))
    }

    func testUnauthorizedRetriesOnceWithRetainedPassword() async throws {
        let device = try await makeDevice()
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        let server = try XCTUnwrap(URL(string: serverA))

        device.authManager.handleAPIError(APIError.unauthorized)
        await device.authManager.recoveryTask?.value

        XCTAssertEqual(device.client.loginPasswords, ["pw-a", "pw-a"])

        // A second expiry in the same process falls through to the sign-in screen.
        device.authManager.handleAPIError(APIError.unauthorized)
        await device.authManager.recoveryTask?.value
        XCTAssertEqual(device.authManager.state, .loggedIn(server: server))
        XCTAssertEqual(device.authManager.pendingReauthentication, server)
        XCTAssertEqual(device.client.loginPasswords.count, 2)
    }

    // MARK: - Two-device sync

    func testRestoredOIDCServerRetainsDiscoveredSignInMethods() async throws {
        for passwordAvailable in [false, true] {
            let client = MockAuthAPIClient(authStatus: AuthStatusResponse(
                authEnabled: true, loggedIn: false, passwordAuthEnabled: passwordAvailable,
                oidcEnabled: true, oidcNativeHandoffEnabled: true
            ))
            let device = try await makeDevice(client: client)
            let setup = makeSetup(url: serverA, password: AuthManager.noPasswordRequired, updatedAt: fixedNow)
            let applied = await device.authManager.applySyncedServers([setup], removing: [], order: [serverA])
            XCTAssertTrue(applied)
            XCTAssertEqual(device.authManager.pendingReauthentication?.absoluteString, serverA)
            XCTAssertTrue(device.authManager.reauthenticationOffersSSO)
            XCTAssertNil(device.authManager.lastErrorMessage, "SSO recovery must not ask for a password.")
            XCTAssertEqual(device.authManager.reauthenticationOffersPassword, passwordAvailable)
            XCTAssertTrue(client.loginPasswords.isEmpty)
        }
    }

    func testRestoreOnSecondDeviceSignsInWithSyncedPassword() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(
            serverURLString: serverA,
            password: "pw-a",
            customHeaders: [CustomHeader(name: "X-Proxy", value: "token-a")]
        )
        deviceA.authManager.updateServerIdentity(
            try XCTUnwrap(deviceA.authManager.servers.first),
            displayName: "Alpha",
            initials: "AL",
            headerLogoColorHex: "#112233"
        )
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        XCTAssertEqual(deviceA.coordinator.status, .synced(fixedNow))
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)
        let payload = try XCTUnwrap(store.records.values.first { $0.type == .serverSetup }?.payload)
        let synced = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: payload)
        XCTAssertEqual(synced.password, "pw-a")
        XCTAssertEqual(synced.displayName, "Alpha")
        XCTAssertEqual(synced.customHeaders, [CustomHeader(name: "X-Proxy", value: "token-a")])

        let deviceB = try await makeDevice(store: store)
        XCTAssertEqual(deviceB.authManager.state, .unconfigured)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        let server = try XCTUnwrap(URL(string: serverA))
        XCTAssertEqual(deviceB.authManager.state, .loggedIn(server: server))
        XCTAssertEqual(deviceB.client.loginPasswords, ["pw-a"], "A fresh session comes from the password, not cookies.")
        XCTAssertEqual(deviceB.authManager.servers.map(\.displayName), ["Alpha"])
        XCTAssertEqual(deviceB.authManager.servers.first?.headerLogoColorHex, "#112233")
        XCTAssertEqual(deviceB.keychain.scopedValue(.serverPassword, scope: serverA), "pw-a")
        XCTAssertEqual(deviceB.authManager.currentCustomHeaders, [CustomHeader(name: "X-Proxy", value: "token-a")])
        XCTAssertEqual(deviceB.coordinator.status, .synced(fixedNow))
        XCTAssertEqual(store.saveCount, 1, "Restoring must not re-upload what was just downloaded.")
    }

    func testRestoreKeepsHeadersAndPasswordsScopedPerServer() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(
            serverURLString: serverA, password: "pw-a", customHeaders: [CustomHeader(name: "X-A", value: "a")]
        )
        _ = await deviceA.authManager.addServer(
            serverURLString: serverB, password: "pw-b", customHeaders: [CustomHeader(name: "X-B", value: "b")]
        )
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        XCTAssertEqual(deviceB.authManager.servers.map(\.id), [serverA, serverB], "Order is synced too.")
        XCTAssertEqual(deviceB.keychain.scopedValue(.serverPassword, scope: serverA), "pw-a")
        XCTAssertEqual(deviceB.keychain.scopedValue(.serverPassword, scope: serverB), "pw-b")
        XCTAssertEqual(
            [CustomHeader].decodeFromStorage(deviceB.keychain.scopedValue(.customHeaders, scope: serverA)),
            [CustomHeader(name: "X-A", value: "a")]
        )
        XCTAssertEqual(
            [CustomHeader].decodeFromStorage(deviceB.keychain.scopedValue(.customHeaders, scope: serverB)),
            [CustomHeader(name: "X-B", value: "b")]
        )
    }

    func testEditsAndRemovalsConvergeAcrossDevices() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-a")
        _ = await deviceA.authManager.addServer(serverURLString: serverB, password: "pw-b")
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()
        XCTAssertEqual(deviceB.authManager.servers.count, 2)

        // Edit on A, remove on A, then B converges without duplicates.
        deviceA.now.advance(by: 30)
        deviceA.authManager.updateServerIdentity(
            try XCTUnwrap(deviceA.authManager.servers.first { $0.id == serverA }),
            displayName: "Alpha Renamed", initials: "AR", headerLogoColorHex: "#445566"
        )
        let removed = try XCTUnwrap(deviceA.authManager.servers.first { $0.id == serverB })
        await deviceA.authManager.removeServer(removed)
        await deviceA.coordinator.sync()
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)

        deviceB.now.advance(by: 60)
        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.authManager.servers.map(\.id), [serverA])
        XCTAssertEqual(deviceB.authManager.servers.first?.displayName, "Alpha Renamed")
        XCTAssertNil(deviceB.keychain.scopedValue(.serverPassword, scope: serverB))
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)
    }

    func testPreferencesSyncOnlyAllowlistedKeys() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-a")
        deviceA.standardDefaults.set(AppTheme.dark.rawValue, forKey: AppTheme.storageKey)
        deviceA.standardDefaults.set(false, forKey: SectionVisibilitySettings.kanbanKey)
        deviceA.standardDefaults.set(true, forKey: ResponseCompletionNotifications.hasRequestedPermissionKey)
        deviceA.standardDefaults.set("apns-token", forKey: TalariaRelayNotifications.pushTokenKey)
        deviceA.appGroupDefaults.set(ProviderQuotaWidgetArcWeight.allCases.last?.rawValue, forKey: ProviderQuotaWidgetArcWeight.storageKey)
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        let record = try XCTUnwrap(store.records[ConfigurationSyncRecord.preferencesRecordName])
        let preferences = try ConfigurationSyncCodec.decoder().decode(SyncedPreferences.self, from: record.payload)
        XCTAssertEqual(preferences.values[AppTheme.storageKey], .string(AppTheme.dark.rawValue))
        XCTAssertEqual(preferences.values[SectionVisibilitySettings.kanbanKey], .bool(false))
        XCTAssertNil(preferences.values[ResponseCompletionNotifications.hasRequestedPermissionKey])
        XCTAssertNil(preferences.values[TalariaRelayNotifications.pushTokenKey])

        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        XCTAssertEqual(deviceB.standardDefaults.string(forKey: AppTheme.storageKey), AppTheme.dark.rawValue)
        XCTAssertEqual(deviceB.standardDefaults.object(forKey: SectionVisibilitySettings.kanbanKey) as? Bool, false)
        XCTAssertEqual(
            deviceB.appGroupDefaults.string(forKey: ProviderQuotaWidgetArcWeight.storageKey),
            ProviderQuotaWidgetArcWeight.allCases.last?.rawValue
        )
        XCTAssertNil(deviceB.standardDefaults.object(forKey: ResponseCompletionNotifications.hasRequestedPermissionKey))
        XCTAssertNil(deviceB.standardDefaults.object(forKey: TalariaRelayNotifications.pushTokenKey))
    }

    func testPasswordChangedBeforePullingRemoteEditIsNotOverwritten() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-old")
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()
        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        // A pushes a newer identity edit; B then changes the password before pulling it.
        deviceA.now.advance(by: 30)
        deviceA.authManager.updateServerIdentity(
            try XCTUnwrap(deviceA.authManager.servers.first),
            displayName: "Renamed", initials: "RN", headerLogoColorHex: "#778899"
        )
        await deviceA.coordinator.sync()
        deviceB.now.advance(by: 60)
        let account = try XCTUnwrap(deviceB.authManager.servers.first)
        let stored = await deviceB.authManager.verifyAndStorePassword(for: account, password: "pw-new")
        XCTAssertTrue(stored)
        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.authManager.serverPassword(for: serverA), "pw-new")
        let payload = try XCTUnwrap(store.records.values.first { $0.type == .serverSetup }?.payload)
        let synced = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: payload)
        XCTAssertEqual(synced.password, "pw-new")
    }

    func testPendingLocalPreferenceEditSurvivesOlderRemoteRecord() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()
        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        // A pushes dark; B chose light later and pulls before its own push.
        deviceA.now.advance(by: 30)
        deviceA.standardDefaults.set(AppTheme.dark.rawValue, forKey: AppTheme.storageKey)
        await deviceA.coordinator.sync()
        deviceB.now.advance(by: 60)
        deviceB.standardDefaults.set(AppTheme.light.rawValue, forKey: AppTheme.storageKey)
        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.standardDefaults.string(forKey: AppTheme.storageKey), AppTheme.light.rawValue)
        let record = try XCTUnwrap(store.records[ConfigurationSyncRecord.preferencesRecordName])
        let preferences = try ConfigurationSyncCodec.decoder().decode(SyncedPreferences.self, from: record.payload)
        XCTAssertEqual(preferences.values[AppTheme.storageKey], .string(AppTheme.light.rawValue))
    }

    func testRegistryWriteFailureDoesNotAdvanceSyncBookkeeping() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-a")
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        let deviceB = try await makeDevice(store: store)
        deviceB.keychain.saveErrors[.servers] = URLError(.cannotWriteToFile)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        guard case .failed = deviceB.coordinator.status else {
            return XCTFail("Expected a failed status, got \(deviceB.coordinator.status)")
        }
        XCTAssertTrue(deviceB.coordinator.state.recordNames.isEmpty)
        XCTAssertNil(deviceB.coordinator.state.changeToken)
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)

        deviceB.keychain.saveErrors = [:]
        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.authManager.servers.map(\.id), [serverA])
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)
    }

    func testLocalWinnerStoresInheritedRemotePasswordLocally() {
        let local = makeSetup(url: serverA, name: "Local", password: nil, updatedAt: fixedNow.addingTimeInterval(10))
        let remote = makeSetup(url: serverA, name: "Remote", password: "pw", updatedAt: fixedNow)
        var state = ConfigurationSyncState()
        state.recordNames[serverA] = "rec-a"

        let plan = ConfigurationSyncMerge.plan(
            local: [local],
            remote: [.init(recordName: "rec-a", setup: remote)],
            remoteDeletions: [],
            state: state,
            now: fixedNow.addingTimeInterval(20)
        )

        XCTAssertEqual(plan.applyLocally.map(\.displayName), ["Local"])
        XCTAssertEqual(plan.applyLocally.first?.password, "pw")
        XCTAssertEqual(plan.upload.map(\.setup.password), ["pw"])
    }

    func testClearedPreferencePropagatesAsRemoval() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        deviceA.standardDefaults.set(AppTheme.dark.rawValue, forKey: AppTheme.storageKey)
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()
        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()
        XCTAssertEqual(deviceB.standardDefaults.string(forKey: AppTheme.storageKey), AppTheme.dark.rawValue)

        deviceA.now.advance(by: 30)
        deviceA.standardDefaults.removeObject(forKey: AppTheme.storageKey)
        await deviceA.coordinator.sync()
        deviceB.now.advance(by: 60)
        await deviceB.coordinator.sync()

        XCTAssertNil(deviceB.standardDefaults.object(forKey: AppTheme.storageKey))
    }

    func testUndecodableRecordDoesNotAdvanceChangeToken() async throws {
        let store = InMemoryConfigurationSyncStore()
        try await store.save(
            [ConfigurationSyncRecord(name: "rec-bad", type: .serverSetup, payload: Data("not json".utf8))],
            deleting: []
        )
        let device = try await makeDevice(store: store)
        device.coordinator.signInWithApple(userID: "apple-user-1")

        await device.coordinator.enableSync()

        guard case .failed = device.coordinator.status else {
            return XCTFail("Expected a failed status, got \(device.coordinator.status)")
        }
        XCTAssertNil(device.coordinator.state.changeToken)
        XCTAssertTrue(device.coordinator.state.recordNames.isEmpty)
    }

    // MARK: - Failure modes

    func testOfflineKeepsChangesPendingUntilNextSync() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        store.saveError = .offline

        await device.coordinator.enableSync()

        XCTAssertEqual(device.coordinator.status, .offline)
        XCTAssertTrue(store.records.isEmpty)
        XCTAssertTrue(device.coordinator.isEnabled)

        store.saveError = nil
        await device.coordinator.sync()

        XCTAssertEqual(device.coordinator.status, .synced(fixedNow))
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)
    }

    func testUnavailableAccountWritesNothing() async throws {
        let store = InMemoryConfigurationSyncStore()
        store.availability = .unavailable("Sign in to iCloud on this iPhone to sync.")
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")

        await device.coordinator.enableSync()

        XCTAssertEqual(device.coordinator.status, .unavailable("Sign in to iCloud on this iPhone to sync."))
        XCTAssertEqual(store.fetchCount, 0)
        XCTAssertTrue(store.records.isEmpty)
        XCTAssertEqual(device.authManager.serverPassword(for: serverA), "pw-a", "Password stays local only.")
    }

    func testEncryptedSaveFailureKeepsPasswordLocalOnly() async throws {
        let store = InMemoryConfigurationSyncStore()
        store.saveError = .failed("iCloud Keychain is unavailable.")
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")

        await device.coordinator.enableSync()

        XCTAssertEqual(device.coordinator.status, .failed("iCloud Keychain is unavailable."))
        XCTAssertTrue(store.records.isEmpty)
        XCTAssertEqual(device.authManager.serverPassword(for: serverA), "pw-a")
        XCTAssertEqual(device.authManager.servers.count, 1)
    }

    func testRevokedAppleCredentialStopsSyncAndKeepsLocalSetup() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()
        device.appleCredentialStatus.value = .revoked

        await device.coordinator.refreshOnForeground()

        XCTAssertEqual(device.coordinator.status, .appleCredentialRevoked)
        XCTAssertFalse(device.coordinator.isEnabled)
        XCTAssertFalse(device.coordinator.isSignedInWithApple)
        XCTAssertEqual(device.authManager.servers.count, 1)
        XCTAssertEqual(device.authManager.serverPassword(for: serverA), "pw-a")
    }

    func testSyncedDataDeletedElsewhereDisablesSyncLocally() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()
        store.fetchError = .syncedDataDeleted

        await device.coordinator.sync()

        XCTAssertFalse(device.coordinator.isEnabled)
        XCTAssertTrue(device.coordinator.isSignedInWithApple)
        XCTAssertEqual(device.coordinator.status, .failed(ConfigurationSyncStoreError.syncedDataDeleted.userMessage))
        XCTAssertEqual(device.authManager.servers.count, 1)
    }

    func testExpiredChangeTokenRefetchesFromScratch() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()
        store.fetchError = .changeTokenExpired
        store.failsNextFetchOnly = true

        await device.coordinator.sync()

        XCTAssertEqual(device.coordinator.status, .synced(fixedNow))
        XCTAssertEqual(store.fetchTokens.last, .some(nil), "Retry must fetch from the beginning.")
    }

    func testEditsMadeWhileSyncIsOffSurviveReenabling() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-old")
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()
        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        // B turns sync off, changes the password, and turns sync back on after
        // A pushed an unrelated edit.
        deviceB.coordinator.disableSync()
        deviceA.now.advance(by: 30)
        deviceA.authManager.updateServerIdentity(
            try XCTUnwrap(deviceA.authManager.servers.first),
            displayName: "Renamed", initials: "RN", headerLogoColorHex: "#778899"
        )
        await deviceA.coordinator.sync()
        deviceB.now.advance(by: 60)
        let account = try XCTUnwrap(deviceB.authManager.servers.first)
        let stored = await deviceB.authManager.verifyAndStorePassword(for: account, password: "pw-new")
        XCTAssertTrue(stored)
        await deviceB.coordinator.enableSync()

        XCTAssertEqual(deviceB.authManager.serverPassword(for: serverA), "pw-new")
        let payload = try XCTUnwrap(store.records.values.first { $0.type == .serverSetup }?.payload)
        let synced = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: payload)
        XCTAssertEqual(synced.password, "pw-new")
    }

    func testNewerPayloadVersionIsRefused() {
        let json = #"{"version":2,"urlString":"https://future.example.test"}"#
        XCTAssertThrowsError(
            try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: Data(json.utf8))
        )
        let preferences = #"{"version":2,"values":{}}"#
        XCTAssertThrowsError(
            try ConfigurationSyncCodec.decoder().decode(SyncedPreferences.self, from: Data(preferences.utf8))
        )
    }

    func testTimestampsKeepSubSecondPrecision() throws {
        let setup = makeSetup(url: serverA, password: "pw", updatedAt: fixedNow.addingTimeInterval(0.25))
        let data = try ConfigurationSyncCodec.encoder().encode(setup)
        let decoded = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: data)
        XCTAssertEqual(decoded.updatedAt.timeIntervalSince1970, setup.updatedAt.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertGreaterThan(decoded.updatedAt, fixedNow)
    }

    func testRelayAppleSignInIsReusedForSync() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store, relayAppleUserID: "apple-user-relay")
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")

        XCTAssertTrue(device.coordinator.isSignedInWithApple, "attach adopts the relay identity")
        XCTAssertFalse(device.coordinator.isEnabled, "sync still waits for the user to turn it on")
        XCTAssertEqual(device.coordinator.status, .disabled)

        await device.coordinator.enableSync()

        XCTAssertEqual(device.coordinator.status, .synced(fixedNow))
        XCTAssertEqual(device.coordinator.state.appleUserID, "apple-user-relay")
    }

    func testRemoteDeletionIsReconciledAfterChangeTokenExpires() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-a")
        _ = await deviceA.authManager.addServer(serverURLString: serverB, password: "pw-b")
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()
        let deviceB = try await makeDevice(store: store)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()
        XCTAssertEqual(deviceB.authManager.servers.count, 2)

        let removed = try XCTUnwrap(deviceA.authManager.servers.first { $0.id == serverB })
        await deviceA.authManager.removeServer(removed)
        await deviceA.coordinator.sync()
        store.fetchError = .changeTokenExpired
        store.failsNextFetchOnly = true
        deviceB.now.advance(by: 60)

        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.authManager.servers.map(\.id), [serverA])
        XCTAssertEqual(store.records.values.filter { $0.type == .serverSetup }.count, 1)
    }

    func testFailedHeaderWriteRollsBackThePartialRemoteApply() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(
            serverURLString: serverA, password: "pw-a", customHeaders: [CustomHeader(name: "X-A", value: "a")]
        )
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        let deviceB = try await makeDevice(store: store)
        deviceB.keychain.saveErrors[.customHeaders] = URLError(.cannotWriteToFile)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        guard case .failed = deviceB.coordinator.status else {
            return XCTFail("Expected a failed status, got \(deviceB.coordinator.status)")
        }
        XCTAssertTrue(deviceB.authManager.servers.isEmpty, "A new server that could not be fully applied is rolled back.")
        XCTAssertNil(deviceB.keychain.scopedValue(.serverPassword, scope: serverA))

        deviceB.keychain.saveErrors = [:]
        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.authManager.servers.map(\.id), [serverA])
        XCTAssertEqual(
            [CustomHeader].decodeFromStorage(deviceB.keychain.scopedValue(.customHeaders, scope: serverA)),
            [CustomHeader(name: "X-A", value: "a")]
        )
        XCTAssertEqual(store.saveCount, 1, "The rolled-back copy must not have been uploaded.")
    }

    func testUnreadableHeadersAbortThePassInsteadOfSyncingEmptyHeaders() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(
            serverURLString: serverA, password: "pw-a", customHeaders: [CustomHeader(name: "X-A", value: "a")]
        )
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()
        device.keychain.scopedLoadErrors[.customHeaders] = URLError(.cannotOpenFile)
        device.now.advance(by: 30)

        await device.coordinator.sync()

        guard case .failed = device.coordinator.status else {
            return XCTFail("Expected a failed status, got \(device.coordinator.status)")
        }
        let payload = try XCTUnwrap(store.records.values.first { $0.type == .serverSetup }?.payload)
        let synced = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: payload)
        XCTAssertEqual(synced.customHeaders, [CustomHeader(name: "X-A", value: "a")])
    }

    func testFailureOnLaterServerRollsBackTheWholeBatch() async throws {
        let store = InMemoryConfigurationSyncStore()
        let deviceA = try await makeDevice(store: store)
        await deviceA.authManager.configure(serverURLString: serverA, password: "pw-a")
        _ = await deviceA.authManager.addServer(serverURLString: serverB, password: "pw-b")
        deviceA.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceA.coordinator.enableSync()

        let deviceB = try await makeDevice(store: store)
        // The password write for every server fails, so the second server's
        // failure must also undo the first one's registry row.
        deviceB.keychain.saveErrors[.serverPassword] = URLError(.cannotWriteToFile)
        deviceB.coordinator.signInWithApple(userID: "apple-user-1")
        await deviceB.coordinator.enableSync()

        XCTAssertTrue(deviceB.authManager.servers.isEmpty)
        XCTAssertTrue(deviceB.coordinator.state.recordNames.isEmpty)

        deviceB.keychain.saveErrors = [:]
        await deviceB.coordinator.sync()

        XCTAssertEqual(deviceB.authManager.servers.map(\.id), [serverA, serverB])
    }

    func testDeleteSyncedDataAbortsWhenDisablingCannotBePersisted() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()
        device.keychain.saveErrors[.configurationSync] = URLError(.cannotWriteToFile)

        await XCTAssertThrowsErrorAsync(try await device.coordinator.deleteSyncedData())

        XCTAssertFalse(store.records.isEmpty, "The zone must survive when the disabled state could not be saved.")
        XCTAssertTrue(device.coordinator.isEnabled)
    }

    func testUnreadablePasswordAbortsThePassInsteadOfErasingIt() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()
        device.keychain.scopedLoadErrors[.serverPassword] = URLError(.cannotOpenFile)
        device.now.advance(by: 30)

        await device.coordinator.sync()

        guard case .failed = device.coordinator.status else {
            return XCTFail("Expected a failed status, got \(device.coordinator.status)")
        }
        let payload = try XCTUnwrap(store.records.values.first { $0.type == .serverSetup }?.payload)
        let synced = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: payload)
        XCTAssertEqual(synced.password, "pw-a")
    }

    func testPassIsNotReportedSyncedWhenBookkeepingCannotBePersisted() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        device.keychain.saveErrors[.configurationSync] = URLError(.cannotWriteToFile)

        await device.coordinator.enableSync()

        guard case .failed = device.coordinator.status else {
            return XCTFail("Expected a failed status, got \(device.coordinator.status)")
        }
        XCTAssertFalse(device.coordinator.isEnabled, "Enabling is reverted when it cannot be saved.")
        XCTAssertTrue(store.records.isEmpty)
    }

    // MARK: - Disconnect and deletion

    func testDisconnectKeepsLocalSetupAndForgetsAppleAccount() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()

        device.coordinator.disconnect()

        XCTAssertEqual(device.coordinator.status, .signedOut)
        XCTAssertEqual(device.authManager.servers.count, 1)
        XCTAssertEqual(device.authManager.serverPassword(for: serverA), "pw-a")
        XCTAssertEqual(store.records.count, 2, "Disconnect leaves iCloud data alone.")
        let persisted = try XCTUnwrap(device.keychain.savedValues[.configurationSync])
        XCTAssertFalse(persisted.contains("apple-user-1"))
    }

    func testDeleteSyncedDataClearsStoreAndDisablesSync() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()

        try await device.coordinator.deleteSyncedData()

        XCTAssertTrue(store.records.isEmpty)
        XCTAssertFalse(device.coordinator.isEnabled)
        XCTAssertTrue(device.coordinator.isSignedInWithApple)
        XCTAssertEqual(device.authManager.servers.count, 1)
    }

    func testSyncStateLivesInKeychainOnly() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        await device.authManager.configure(serverURLString: serverA, password: "pw-a")
        device.coordinator.signInWithApple(userID: "apple-user-1")
        await device.coordinator.enableSync()

        let persisted = try XCTUnwrap(device.keychain.savedValues[.configurationSync])
        XCTAssertTrue(persisted.contains("apple-user-1"))
        XCTAssertFalse(persisted.contains("pw-a"))
        for key in device.standardDefaults.dictionaryRepresentation().keys {
            XCTAssertFalse(key.lowercased().contains("sync"), "Sync state must not land in UserDefaults: \(key)")
        }
    }

    // MARK: - Missing credentials

    func testPreexistingServerWithoutPasswordIsReportedThenVerified() async throws {
        let store = InMemoryConfigurationSyncStore()
        let device = try await makeDevice(store: store)
        // A server configured before passwords were retained: registry only.
        try device.registry.activate(url: XCTUnwrap(URL(string: serverA)))
        let restarted = try await makeDevice(store: store, keychain: device.keychain, registry: device.registry)
        restarted.coordinator.signInWithApple(userID: "apple-user-1")

        await restarted.coordinator.enableSync()
        XCTAssertEqual(restarted.coordinator.status, .missingCredentials([serverA]))

        let account = try XCTUnwrap(restarted.authManager.servers.first)
        let rejectedEmpty = await restarted.authManager.verifyAndStorePassword(for: account, password: "")
        XCTAssertFalse(rejectedEmpty)
        let accepted = await restarted.authManager.verifyAndStorePassword(for: account, password: "pw-a")
        XCTAssertTrue(accepted)
        XCTAssertEqual(restarted.client.loginPasswords, ["pw-a"])
        await restarted.coordinator.sync()

        XCTAssertEqual(restarted.coordinator.status, .synced(fixedNow))
        let payload = try XCTUnwrap(store.records.values.first { $0.type == .serverSetup }?.payload)
        let synced = try ConfigurationSyncCodec.decoder().decode(SyncedServerSetup.self, from: payload)
        XCTAssertEqual(synced.password, "pw-a")
    }

    func testServersSignedInWithSSOOrWithoutPasswordsResolveAutomatically() async throws {
        let store = InMemoryConfigurationSyncStore()
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        // Pre-existing servers: one signed in with SSO on this device, one whose
        // password login is disabled; neither has a retained password.
        try registry.activate(url: XCTUnwrap(URL(string: serverA)))
        try registry.activate(url: XCTUnwrap(URL(string: serverB)))
        try keychain.save("ops", forKey: .authenticatedProfile, scope: serverA)
        let client = MockAuthAPIClient(
            authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false, passwordAuthEnabled: false, oidcEnabled: true)
        )
        let device = try await makeDevice(store: store, client: client, keychain: keychain, registry: registry)
        device.coordinator.signInWithApple(userID: "apple-user-1")

        await device.coordinator.enableSync()

        XCTAssertEqual(device.coordinator.status, .synced(fixedNow))
        XCTAssertEqual(device.authManager.serverPassword(for: serverA), AuthManager.noPasswordRequired)
        XCTAssertEqual(device.authManager.serverPassword(for: serverB), AuthManager.noPasswordRequired)
        XCTAssertTrue(client.loginPasswords.isEmpty, "Resolution never sends a password.")
    }

    // MARK: - Helpers

    private struct Device {
        let authManager: AuthManager
        let coordinator: ConfigurationSyncCoordinator
        let keychain: InMemoryKeychainStore
        let registry: ServerRegistry
        let client: MockAuthAPIClient
        let standardDefaults: UserDefaults
        let appGroupDefaults: UserDefaults
        let now: MutableClock
        let appleCredentialStatus: LockedValue<TalariaRelayAppleCredentialStatus>
    }

    private func makeDevice(
        store: InMemoryConfigurationSyncStore = InMemoryConfigurationSyncStore(),
        client: MockAuthAPIClient? = nil,
        keychain: InMemoryKeychainStore = InMemoryKeychainStore(),
        registry: ServerRegistry? = nil,
        relayAppleUserID: String? = nil
    ) async throws -> Device {
        let client = client ?? MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let registry = registry ?? ServerRegistry.inMemory(keychain: keychain)
        let clock = MutableClock(fixedNow)
        let credentialStatus = LockedValue<TalariaRelayAppleCredentialStatus>(.authorized)
        let authManager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            headerStore: CustomHeaderStore(),
            cookieStorage: URLSessionConfiguration.ephemeral.httpCookieStorage!,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: registry
        )
        let standardDefaults = UserDefaults.ephemeral()
        let appGroupDefaults = UserDefaults.ephemeral()
        let coordinator = ConfigurationSyncCoordinator(
            store: store,
            keychain: keychain,
            standardDefaults: standardDefaults,
            appGroupDefaults: appGroupDefaults,
            now: { clock.now },
            appleCredentialStatus: { _ in credentialStatus.value },
            relayAppleUserID: { relayAppleUserID },
            debounce: .milliseconds(1)
        )
        coordinator.attach(authManager: authManager, observingLocalChanges: false)
        return Device(
            authManager: authManager,
            coordinator: coordinator,
            keychain: keychain,
            registry: registry,
            client: client,
            standardDefaults: standardDefaults,
            appGroupDefaults: appGroupDefaults,
            now: clock,
            appleCredentialStatus: credentialStatus
        )
    }

    private func makeSetup(
        url: String,
        name: String = "Server",
        password: String?,
        headers: [CustomHeader] = [],
        updatedAt: Date
    ) -> SyncedServerSetup {
        SyncedServerSetup(
            urlString: url,
            displayName: name,
            initials: "SV",
            headerLogoColorHex: HeaderLogoColor.defaultHex,
            password: password,
            customHeaders: headers,
            position: 0,
            updatedAt: updatedAt
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            guard ContinuousClock.now < deadline else {
                XCTFail("Condition not met within \(timeout)")
                return
            }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}

func XCTAssertThrowsErrorAsync(
    _ expression: @autoclosure () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected an error", file: file, line: line)
    } catch {}
}

// MARK: - Test doubles

/// Replays saves as a change log with an integer token, the way the CloudKit
/// zone-changes API does, so two "devices" sharing one store see each other's
/// edits and deletions.
final class InMemoryConfigurationSyncStore: ConfigurationSyncStore, @unchecked Sendable {
    private struct Change {
        let sequence: Int
        let name: String
        let deleted: Bool
    }

    private let lock = NSLock()
    private(set) var records: [String: ConfigurationSyncRecord] = [:]
    private var changes: [Change] = []
    private(set) var saveCount = 0
    private(set) var fetchCount = 0
    private(set) var fetchTokens: [Data?] = []
    var availability: ConfigurationSyncAccountAvailability = .available
    var saveError: ConfigurationSyncStoreError?
    var fetchError: ConfigurationSyncStoreError?
    var failsNextFetchOnly = false

    func accountAvailability() async -> ConfigurationSyncAccountAvailability {
        lock.withLock { availability }
    }

    func fetchChanges(since token: Data?) async throws -> ConfigurationSyncChanges {
        try lock.withLock {
            fetchCount += 1
            fetchTokens.append(token)
            if let fetchError {
                if failsNextFetchOnly { self.fetchError = nil }
                throw fetchError
            }
            let since = token.flatMap { Int(String(decoding: $0, as: UTF8.self)) } ?? 0
            var result = ConfigurationSyncChanges()
            var latestByName: [String: Change] = [:]
            for change in changes where change.sequence > since {
                latestByName[change.name] = change
            }
            for change in latestByName.values.sorted(by: { $0.sequence < $1.sequence }) {
                if change.deleted {
                    result.deletedRecordNames.append(change.name)
                } else if let record = records[change.name] {
                    result.changed.append(record)
                }
            }
            let last = changes.last?.sequence ?? 0
            result.changeToken = Data(String(last).utf8)
            return result
        }
    }

    func save(_ saved: [ConfigurationSyncRecord], deleting recordNames: [String]) async throws {
        try lock.withLock {
            if let saveError { throw saveError }
            guard !saved.isEmpty || !recordNames.isEmpty else { return }
            saveCount += 1
            for record in saved {
                records[record.name] = record
                changes.append(Change(sequence: changes.count + 1, name: record.name, deleted: false))
            }
            for name in recordNames {
                records.removeValue(forKey: name)
                changes.append(Change(sequence: changes.count + 1, name: name, deleted: true))
            }
        }
    }

    func deleteAll() async throws {
        lock.withLock {
            records = [:]
            changes = []
        }
    }
}

final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ date: Date) { current = date }

    var now: Date { lock.withLock { current } }

    func advance(by seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

final class LockedValue<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
