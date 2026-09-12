import Foundation
import Observation
import os

private let syncLogger = Logger(subsystem: "dev.kil.talaria", category: "ConfigurationSync")

extension Notification.Name {
    /// Posted by `AuthManager` after a server, credential, or header change is
    /// persisted, so sync can pick it up without every caller knowing.
    static let talariaServerConfigurationChanged = Notification.Name("talariaServerConfigurationChanged")
}

/// Owns Sign in with Apple state and CloudKit sync for server setup and
/// allowlisted preferences (TAL-91). One instance per process; `AuthManager`
/// supplies the local server list and applies what CloudKit says.
///
/// Every failure is fail-closed: nothing is written to CloudKit unless the
/// account is available and the record saved, and nothing local is deleted
/// unless CloudKit reported that record as deleted.
@MainActor
@Observable
final class ConfigurationSyncCoordinator {
    static let shared: ConfigurationSyncCoordinator = {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.launchArgument) {
            return ConfigurationSyncCoordinator(
                store: UnavailableConfigurationSyncStore(reason: "iCloud sync is off in the UI-test fixture."),
                keychain: nil
            )
        }
        #endif
        guard let containerIdentifier = CloudKitConfigurationSyncStore.configuredContainerIdentifier else {
            return ConfigurationSyncCoordinator(
                store: UnavailableConfigurationSyncStore(
                    reason: String(localized: "This build has no iCloud container configured.")
                )
            )
        }
        return ConfigurationSyncCoordinator(
            store: CloudKitConfigurationSyncStore(containerIdentifier: containerIdentifier)
        )
    }()

    private(set) var status: ConfigurationSyncStatus = .signedOut
    private(set) var state: ConfigurationSyncState

    private let store: any ConfigurationSyncStore
    private let keychain: (any KeychainStoring)?
    private let standardDefaults: UserDefaults
    private let appGroupDefaults: UserDefaults
    private let now: () -> Date
    private let appleCredentialStatus: @Sendable (String) async -> TalariaRelayAppleCredentialStatus
    /// The Apple user already signed in for Talaria Relay, if any. Both
    /// features see the same Apple identity, so sync reuses it instead of
    /// asking for a second sign-in.
    private let relayAppleUserID: () -> String?
    private let debounce: Duration

    @ObservationIgnored private weak var authManager: AuthManager?
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []
    @ObservationIgnored private var scheduledSync: Task<Void, Never>?
    @ObservationIgnored private var activeSync: Task<Void, Never>?
    @ObservationIgnored private var syncRequestedWhileRunning = false
    /// True while remote changes are being written locally, so the resulting
    /// change notifications do not schedule a sync of what was just applied.
    @ObservationIgnored private var isApplyingRemote = false

    init(
        store: any ConfigurationSyncStore,
        keychain: (any KeychainStoring)? = KeychainStore(),
        standardDefaults: UserDefaults = .standard,
        appGroupDefaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults,
        now: @escaping () -> Date = { Date() },
        appleCredentialStatus: @escaping @Sendable (String) async -> TalariaRelayAppleCredentialStatus = {
            await TalariaRelayAppleCredentialState.status(userID: $0)
        },
        relayAppleUserID: @escaping () -> String? = {
            guard let credentials = TalariaRelayConfigurationStore.load(),
                  credentials.pendingRevocation != true else { return nil }
            return credentials.appleUserID
        },
        debounce: Duration = .seconds(1.5)
    ) {
        self.store = store
        self.keychain = keychain
        self.standardDefaults = standardDefaults
        self.appGroupDefaults = appGroupDefaults
        self.now = now
        self.appleCredentialStatus = appleCredentialStatus
        self.relayAppleUserID = relayAppleUserID
        self.debounce = debounce
        state = Self.loadState(from: keychain)
        status = state.appleUserID == nil ? .signedOut : (state.isEnabled ? .synced(state.lastSyncAt) : .disabled)
    }

    var isSignedInWithApple: Bool { state.appleUserID != nil }
    var isEnabled: Bool { state.isEnabled }

    /// Connects the manager whose servers are synced and, by default, starts
    /// listening for local changes. Call once from the app root; tests pass
    /// `observingLocalChanges: false` and drive `sync()` directly.
    func attach(authManager: AuthManager, observingLocalChanges: Bool = true) {
        self.authManager = authManager
        adoptRelayIdentityIfNeeded()
        guard observingLocalChanges, observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .talariaServerConfigurationChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.scheduleSync() }
        })
        observers.append(center.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.scheduleSync(onlyIfPreferencesChanged: true) }
        })
    }

    // MARK: - Account

    /// Reuses the Apple sign-in Talaria Relay already holds, so a user who
    /// connected the relay never signs in a second time for sync. Sync itself
    /// stays off until they turn it on.
    func adoptRelayIdentityIfNeeded() {
        guard state.appleUserID == nil, let userID = relayAppleUserID() else { return }
        signInWithApple(userID: userID)
    }

    func signInWithApple(userID: String) {
        if state.appleUserID != userID {
            state.resetRemoteBookkeeping()
        }
        state.appleUserID = userID
        persistState()
        status = .disabled
    }

    func enableSync() async {
        guard state.appleUserID != nil else {
            status = .signedOut
            return
        }
        state.isEnabled = true
        persistState()
        await sync()
    }

    /// Stops syncing. Local servers, passwords, and preferences stay exactly
    /// as they are, and so does the bookkeeping: edits made while sync is off
    /// are stamped against the last synced baseline when it is turned back on,
    /// so an older CloudKit copy cannot overwrite them.
    func disableSync() {
        state.isEnabled = false
        scheduledSync?.cancel()
        persistState()
        status = .disabled
    }

    /// Stops syncing and forgets the remote bookkeeping, for a zone that no
    /// longer exists or an account that is no longer this one.
    private func forgetRemoteState() {
        state.resetRemoteBookkeeping()
        scheduledSync?.cancel()
        persistState()
        status = .disabled
    }

    /// Disconnect: stop syncing and forget the Apple sign-in. Local setup stays.
    func disconnect() {
        state.resetRemoteBookkeeping()
        state.appleUserID = nil
        persistState()
        status = .signedOut
    }

    /// Deletes every synced Talaria record from the user's private database,
    /// then stops syncing on this device. Local setup stays.
    func deleteSyncedData() async throws {
        // Stop new passes and let an in-flight one finish first, so nothing can
        // recreate the zone after it is gone.
        state.isEnabled = false
        persistState()
        scheduledSync?.cancel()
        if let activeSync {
            await activeSync.value
        }
        do {
            try await store.deleteAll()
        } catch {
            let mapped = CloudKitConfigurationSyncStore.mapped(error)
            status = .failed(mapped.userMessage)
            throw mapped
        }
        forgetRemoteState()
    }

    func handleAppleCredentialRevoked() {
        guard state.appleUserID != nil else { return }
        state.resetRemoteBookkeeping()
        state.appleUserID = nil
        persistState()
        status = .appleCredentialRevoked
    }

    /// Re-checks the Apple credential (foreground) and syncs when enabled.
    func refreshOnForeground() async {
        adoptRelayIdentityIfNeeded()
        guard let appleUserID = state.appleUserID else { return }
        if await appleCredentialStatus(appleUserID) == .revoked {
            handleAppleCredentialRevoked()
            return
        }
        await syncIfEnabled()
    }

    func syncIfEnabled() async {
        guard state.isEnabled else { return }
        await sync()
    }

    // MARK: - Sync

    /// Coalesces bursts of local edits into one sync.
    func scheduleSync(onlyIfPreferencesChanged: Bool = false) {
        guard state.isEnabled, !isApplyingRemote, let authManager else { return }
        stampLocalChanges(authManager)
        let preferencesChanged = localPreferences().fingerprint != state.preferencesMark?.fingerprint
        guard preferencesChanged || (!onlyIfPreferencesChanged && hasUnsyncedServerChanges(authManager)) else {
            return
        }
        scheduledSync?.cancel()
        let delay = debounce
        scheduledSync = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// One full pull → merge → push pass. Concurrent calls wait for the running
    /// pass and trigger exactly one more.
    func sync() async {
        if let activeSync {
            syncRequestedWhileRunning = true
            await activeSync.value
            return
        }
        let task = Task { await performSync() }
        activeSync = task
        await task.value
        activeSync = nil
        if syncRequestedWhileRunning {
            syncRequestedWhileRunning = false
            await sync()
        }
    }

    private func performSync() async {
        guard state.appleUserID != nil else {
            status = .signedOut
            return
        }
        guard state.isEnabled, let authManager else {
            status = .disabled
            return
        }
        stampLocalChanges(authManager)
        await authManager.resolveMissingPasswordMarkers()
        if case .unavailable(let reason) = await store.accountAvailability() {
            status = .unavailable(reason)
            return
        }
        status = .syncing

        let changes: ConfigurationSyncChanges
        do {
            changes = try await fetchChangesResettingExpiredToken()
        } catch {
            handle(error)
            return
        }

        // Sync may have been turned off or disconnected while the fetch was
        // suspended; those promised to leave local setup alone.
        guard state.isEnabled, state.appleUserID != nil else {
            status = state.appleUserID == nil ? .signedOut : .disabled
            return
        }

        // A payload this build cannot decode must not be skipped: accepting the
        // token would drop that change from every later delta.
        let remoteSetups: [ConfigurationSyncMerge.RemoteSetup]
        let remotePreferences: SyncedPreferences?
        do {
            let decoder = ConfigurationSyncCodec.decoder()
            remoteSetups = try changes.changed.filter { $0.type == .serverSetup }.map {
                .init(recordName: $0.name, setup: try decoder.decode(SyncedServerSetup.self, from: $0.payload))
            }
            remotePreferences = try changes.changed.first { $0.type == .preferences }.map {
                try decoder.decode(SyncedPreferences.self, from: $0.payload)
            }
        } catch {
            status = .failed(String(localized: "A synced record could not be read by this version of Talaria."))
            syncLogger.warning("Configuration sync payload undecodable: \(String(describing: type(of: error)), privacy: .public)")
            return
        }

        let plan = ConfigurationSyncMerge.plan(
            local: localSetups(authManager),
            remote: remoteSetups,
            remoteDeletions: changes.deletedRecordNames,
            state: state,
            now: now()
        )

        isApplyingRemote = true
        defer { isApplyingRemote = false }
        if !plan.applyLocally.isEmpty || !plan.removeLocally.isEmpty {
            let applied = await authManager.applySyncedServers(
                plan.applyLocally, removing: plan.removeLocally, order: plan.order
            )
            guard applied else {
                // Nothing is recorded as downloaded: the next pass fetches the same
                // changes again instead of treating the missing server as removed.
                status = .failed(authManager.lastErrorMessage ?? String(localized: "Could not apply synced servers."))
                return
            }
        }
        var preferencesMark = state.preferencesMark
        let pendingPreferenceEdit = state.preferencesChangedAt ?? .distantPast
        if let remotePreferences,
           remotePreferences.updatedAt > max(preferencesMark?.changedAt ?? .distantPast, pendingPreferenceEdit) {
            SyncedPreferenceAllowlist.apply(remotePreferences.values, standard: standardDefaults, appGroup: appGroupDefaults)
            preferencesMark = .init(fingerprint: remotePreferences.fingerprint, changedAt: remotePreferences.updatedAt)
            state.preferencesChangedAt = nil
        }
        isApplyingRemote = false
        // The user may have turned sync off or deleted the synced data while
        // this pass was fetching; never push after that.
        guard state.isEnabled else {
            status = .disabled
            return
        }

        // Bookkeeping for what was downloaded is safe to keep even if the push
        // below fails: those records already match CloudKit.
        state.changeToken = changes.changeToken
        state.recordNames = plan.recordNames
        state.uploaded = plan.uploaded
        state.pendingDeletions = plan.deleteRemote
        state.preferencesMark = preferencesMark

        var records: [ConfigurationSyncRecord] = []
        var uploadedMarks: [String: ConfigurationSyncState.UploadMark] = [:]
        var localChangedAt = state.localChangedAt
        do {
            for upload in plan.upload {
                records.append(try .serverSetup(name: upload.recordName, upload.setup))
                uploadedMarks[upload.setup.serverID] = .init(fingerprint: upload.setup.fingerprint, changedAt: upload.setup.updatedAt)
                localChangedAt[upload.setup.serverID] = upload.setup.updatedAt
            }
            let preferences = localPreferences()
            var preferencesUpload: ConfigurationSyncState.UploadMark?
            if preferences.fingerprint != preferencesMark?.fingerprint {
                let stamped = SyncedPreferences(
                    values: preferences.values,
                    updatedAt: max(now(), state.preferencesChangedAt ?? .distantPast)
                )
                records.append(try .preferences(stamped))
                preferencesUpload = .init(fingerprint: stamped.fingerprint, changedAt: stamped.updatedAt)
            }
            try await store.save(records, deleting: plan.deleteRemote)
            state.uploaded.merge(uploadedMarks) { _, new in new }
            state.localChangedAt = localChangedAt.filter { plan.recordNames[$0.key] != nil }
            state.pendingDeletions = []
            if let preferencesUpload {
                state.preferencesMark = preferencesUpload
                state.preferencesChangedAt = nil
            }
            state.lastSyncAt = now()
            persistState()
            status = finishedStatus(authManager)
        } catch {
            persistState()
            handle(error)
        }
    }

    private func fetchChangesResettingExpiredToken() async throws -> ConfigurationSyncChanges {
        do {
            return try await store.fetchChanges(since: state.changeToken)
        } catch ConfigurationSyncStoreError.changeTokenExpired {
            state.changeToken = nil
            return try await store.fetchChanges(since: nil)
        }
    }

    private func handle(_ error: Error) {
        let mapped = CloudKitConfigurationSyncStore.mapped(error)
        switch mapped {
        case .offline:
            status = .offline
        case .syncedDataDeleted:
            forgetRemoteState()
            status = .failed(mapped.userMessage)
        case .accountUnavailable(let reason):
            status = .unavailable(reason)
        case .changeTokenExpired, .failed:
            status = .failed(mapped.userMessage)
        }
        syncLogger.warning("Configuration sync failed: \(mapped.userMessage, privacy: .public)")
    }

    private func finishedStatus(_ authManager: AuthManager) -> ConfigurationSyncStatus {
        let missing = authManager.servers.filter { authManager.serverPassword(for: $0.id) == nil }.map(\.id)
        return missing.isEmpty ? .synced(state.lastSyncAt) : .missingCredentials(missing)
    }

    // MARK: - Local snapshots

    /// Records when a local server or preference edit made *after* a sync was
    /// first seen, so the merge compares it against remote timestamps. Password
    /// and header writes do not bump the registry's `updatedAt`, and a debounced
    /// push can lose a race with a pull, so the stamp is taken here rather than
    /// at write time. Anything never synced carries no stamp: on a device's
    /// first sync the cloud copy wins, which is what "restore" means.
    private func stampLocalChanges(_ authManager: AuthManager) {
        var changed = false
        for setup in localSetups(authManager) {
            guard let uploaded = state.uploaded[setup.serverID],
                  uploaded.fingerprint != setup.fingerprint,
                  (state.localChangedAt[setup.serverID] ?? .distantPast) <= uploaded.changedAt else { continue }
            state.localChangedAt[setup.serverID] = now()
            changed = true
        }
        if state.preferencesChangedAt == nil,
           let mark = state.preferencesMark,
           localPreferences().fingerprint != mark.fingerprint {
            state.preferencesChangedAt = now()
            changed = true
        }
        if changed {
            persistState()
        }
    }

    /// Whether the local server list differs from what CloudKit last saw, so a
    /// change notification for something already synced costs no network call.
    private func hasUnsyncedServerChanges(_ authManager: AuthManager) -> Bool {
        let local = localSetups(authManager)
        let localIDs = Set(local.map(\.serverID))
        if state.recordNames.keys.contains(where: { !localIDs.contains($0) }) { return true }
        return local.contains { state.uploaded[$0.serverID]?.fingerprint != $0.fingerprint }
    }

    private func localSetups(_ authManager: AuthManager) -> [SyncedServerSetup] {
        authManager.servers.enumerated().map { index, account in
            SyncedServerSetup(
                account: account,
                password: authManager.serverPassword(for: account.id),
                customHeaders: authManager.customHeaders(for: account),
                position: index,
                updatedAt: max(account.updatedAt, state.localChangedAt[account.id] ?? .distantPast)
            )
        }
    }

    private func localPreferences() -> SyncedPreferences {
        SyncedPreferences(
            values: SyncedPreferenceAllowlist.snapshot(standard: standardDefaults, appGroup: appGroupDefaults),
            updatedAt: now()
        )
    }

    // MARK: - Persistence

    private static func loadState(from keychain: (any KeychainStoring)?) -> ConfigurationSyncState {
        guard let keychain,
              let json = try? keychain.load(.configurationSync),
              let data = json.data(using: .utf8),
              let state = try? ConfigurationSyncCodec.decoder().decode(ConfigurationSyncState.self, from: data)
        else { return ConfigurationSyncState() }
        return state
    }

    private func persistState() {
        guard let keychain else { return }
        do {
            let data = try ConfigurationSyncCodec.encoder().encode(state)
            try keychain.save(String(decoding: data, as: UTF8.self), forKey: .configurationSync)
        } catch {
            syncLogger.error("Could not persist sync state: \(error.localizedDescription, privacy: .public)")
        }
    }
}
