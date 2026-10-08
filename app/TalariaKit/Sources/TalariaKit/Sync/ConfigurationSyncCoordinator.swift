import Foundation
import Observation
import os

private let syncLogger = Logger(subsystem: "dev.kil.talaria", category: "ConfigurationSync")

extension Notification.Name {
    /// Posted by `AuthManager` after a server, credential, or header change is
    /// persisted, so sync can pick it up without every caller knowing.
    public static let talariaServerConfigurationChanged = Notification.Name("talariaServerConfigurationChanged")
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
public final class ConfigurationSyncCoordinator {
    public static let shared: ConfigurationSyncCoordinator = {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(UITestFixtureLaunch.launchArgument) {
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

    public private(set) var status: ConfigurationSyncStatus = .signedOut
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

    public var isSignedInWithApple: Bool { state.appleUserID != nil }
    public var isEnabled: Bool { state.isEnabled }

    /// Connects the manager whose servers are synced and, by default, starts
    /// listening for local changes. Call once from the app root; tests pass
    /// `observingLocalChanges: false` and drive `sync()` directly.
    public func attach(authManager: AuthManager, observingLocalChanges: Bool = true) {
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
    public func adoptRelayIdentityIfNeeded() {
        guard state.appleUserID == nil, let userID = relayAppleUserID() else { return }
        signInWithApple(userID: userID)
    }

    public func signInWithApple(userID: String) {
        let previous = state
        if state.appleUserID != userID {
            state.resetRemoteBookkeeping()
        }
        state.appleUserID = userID
        guard commitState(revertingTo: previous) else { return }
        status = .disabled
    }

    public func enableSync() async {
        guard state.appleUserID != nil else {
            status = .signedOut
            return
        }
        let previous = state
        state.isEnabled = true
        guard commitState(revertingTo: previous) else { return }
        await sync()
    }

    /// Stops syncing. Local servers, passwords, and preferences stay exactly
    /// as they are, and so does the bookkeeping: edits made while sync is off
    /// are stamped against the last synced baseline when it is turned back on,
    /// so an older CloudKit copy cannot overwrite them.
    public func disableSync() {
        let previous = state
        state.isEnabled = false
        scheduledSync?.cancel()
        guard commitState(revertingTo: previous) else { return }
        status = .disabled
    }

    /// Stops syncing and forgets the remote bookkeeping, for a zone that no
    /// longer exists or an account that is no longer this one.
    private func forgetRemoteState() {
        let previous = state
        state.resetRemoteBookkeeping()
        scheduledSync?.cancel()
        guard commitState(revertingTo: previous) else { return }
        status = .disabled
    }

    /// Disconnect: stop syncing and forget the Apple sign-in. Local setup stays.
    /// Returns false, with the state reverted, when it could not be persisted.
    @discardableResult
    public func disconnect() -> Bool {
        let previous = state
        state.resetRemoteBookkeeping()
        state.appleUserID = nil
        scheduledSync?.cancel()
        guard commitState(revertingTo: previous) else { return false }
        status = .signedOut
        return true
    }

    /// Persists an account or toggle change, or reverts it and reports the
    /// failure so Settings never shows a choice that would not survive relaunch.
    private func commitState(revertingTo previous: ConfigurationSyncState) -> Bool {
        guard persistState() else {
            state = previous
            status = .failed(String(localized: "Could not save sync settings to the Keychain."))
            return false
        }
        return true
    }

    /// Deletes every synced Talaria record from the user's private database,
    /// then stops syncing on this device. Local setup stays.
    public func deleteSyncedData() async throws {
        // Stop new passes and let an in-flight one finish first, so nothing can
        // recreate the zone after it is gone. If that cannot be persisted the
        // deletion is not attempted: a relaunch would resume and repopulate it.
        let previous = state
        state.isEnabled = false
        guard commitState(revertingTo: previous) else {
            throw ConfigurationSyncStoreError.failed(String(localized: "Could not save sync settings to the Keychain."))
        }
        scheduledSync?.cancel()
        if let activeSync {
            await activeSync.value
        }
        do {
            try await store.deleteAll()
        } catch {
            let mapped = CloudKitConfigurationSyncStore.mapped(error)
            status = .failed(mapped.userMessage, detail: mapped.detail)
            throw mapped
        }
        forgetRemoteState()
    }

    public func handleAppleCredentialRevoked() {
        guard state.appleUserID != nil else { return }
        state.resetRemoteBookkeeping()
        state.appleUserID = nil
        persistState()
        status = .appleCredentialRevoked
    }

    /// Re-checks the Apple credential (foreground) and syncs when enabled.
    public func refreshOnForeground() async {
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
        guard stampLocalChanges(authManager) else { return }
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
    public func sync() async {
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
        guard stampLocalChanges(authManager) else {
            status = .failed(String(localized: "Could not read server settings from the Keychain."))
            return
        }
        await authManager.resolveMissingPasswordMarkers()
        if case .unavailable(let reason) = await store.accountAvailability() {
            status = .unavailable(reason)
            return
        }
        status = .syncing

        var changes: ConfigurationSyncChanges
        let fetchedFullSnapshot: Bool
        do {
            (changes, fetchedFullSnapshot) = try await fetchChangesResettingExpiredToken()
        } catch {
            handle(error)
            return
        }
        if fetchedFullSnapshot {
            // A snapshot carries no tombstones: every record this device mapped
            // that is no longer present was deleted while the token was invalid.
            let present = Set(changes.changed.map(\.name))
            changes.deletedRecordNames += state.recordNames.values.filter { !present.contains($0) }
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
            remoteSetups = try changes.changed.filter { $0.type == .serverSetup }.compactMap {
                let setup = try decoder.decode(SyncedServerSetup.self, from: $0.payload)
                // A record naming something that is not a normalized server URL can
                // never become a local server; it is left alone rather than mapped,
                // so a later pass cannot mistake it for a local removal.
                guard (try? AuthManager.normalizedServerURL(from: setup.urlString))?.absoluteString == setup.urlString else {
                    syncLogger.warning("Ignoring synced server record with an invalid URL")
                    return nil
                }
                return .init(recordName: $0.name, setup: setup)
            }
            remotePreferences = try changes.changed.first { $0.type == .preferences }.map {
                try decoder.decode(SyncedPreferences.self, from: $0.payload)
            }
        } catch {
            status = .failed(String(localized: "A synced record could not be read by this version of Talaria."))
            syncLogger.warning("Configuration sync payload undecodable: \(String(describing: type(of: error)), privacy: .public)")
            return
        }

        guard let localSetups = localSetups(authManager) else {
            status = .failed(String(localized: "Could not read server settings from the Keychain."))
            return
        }
        let plan = ConfigurationSyncMerge.plan(
            local: localSetups,
            remote: remoteSetups,
            remoteDeletions: changes.deletedRecordNames,
            state: state,
            now: now()
        )

        isApplyingRemote = true
        defer { isApplyingRemote = false }
        if !plan.applyLocally.isEmpty || !plan.removeLocally.isEmpty {
            let applied = await authManager.applySyncedServers(
                plan.applyLocally, removing: plan.removeLocally, order: plan.order,
                shouldContinue: { [weak self] in self?.state.isEnabled == true }
            )
            guard applied else {
                if !state.isEnabled {
                    status = .disabled
                    return
                }
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
            // The pass is only done once its baseline is durable: after a relaunch
            // without it, downloaded values would look like fresh local edits.
            guard persistState() else {
                status = .failed(String(localized: "Could not save sync settings to the Keychain."))
                return
            }
            status = finishedStatus(authManager)
        } catch {
            persistState()
            handle(error)
        }
    }

    /// Returns the changes and whether they are a full snapshot (no token).
    private func fetchChangesResettingExpiredToken() async throws -> (ConfigurationSyncChanges, Bool) {
        do {
            return (try await store.fetchChanges(since: state.changeToken), state.changeToken == nil)
        } catch ConfigurationSyncStoreError.changeTokenExpired {
            state.changeToken = nil
            return (try await store.fetchChanges(since: nil), true)
        }
    }

    private func handle(_ error: Error) {
        let mapped = CloudKitConfigurationSyncStore.mapped(error)
        switch mapped {
        case .offline:
            status = .offline
        case .syncedDataDeleted:
            forgetRemoteState()
            status = .failed(mapped.userMessage, detail: mapped.detail)
        case .accountUnavailable(let reason):
            status = .unavailable(reason)
        case .changeTokenExpired, .failed:
            status = .failed(mapped.userMessage, detail: mapped.detail)
        }
        syncLogger.warning("Configuration sync failed: \(mapped.detail ?? mapped.userMessage, privacy: .public)")
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
    /// Returns false when the local snapshot could not be read; nothing is
    /// stamped then, because an unreadable header set must not look deleted.
    @discardableResult
    private func stampLocalChanges(_ authManager: AuthManager) -> Bool {
        guard let setups = localSetups(authManager) else { return false }
        var changed = false
        for setup in setups {
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
        return true
    }

    /// Whether the local server list differs from what CloudKit last saw, so a
    /// change notification for something already synced costs no network call.
    private func hasUnsyncedServerChanges(_ authManager: AuthManager) -> Bool {
        guard let local = localSetups(authManager) else { return false }
        let localIDs = Set(local.map(\.serverID))
        if state.recordNames.keys.contains(where: { !localIDs.contains($0) }) { return true }
        return local.contains { state.uploaded[$0.serverID]?.fingerprint != $0.fingerprint }
    }

    /// Nil when any server's headers could not be read from the Keychain: a
    /// failed read must never be mistaken for an empty header set.
    private func localSetups(_ authManager: AuthManager) -> [SyncedServerSetup]? {
        var setups: [SyncedServerSetup] = []
        for (index, account) in authManager.servers.enumerated() {
            guard let headers = authManager.customHeadersIfReadable(for: account) else { return nil }
            let password: String?
            do {
                password = try authManager.serverPasswordReadingKeychain(for: account.id)
            } catch {
                return nil
            }
            setups.append(SyncedServerSetup(
                account: account,
                password: password,
                customHeaders: headers,
                position: index,
                updatedAt: max(account.updatedAt, state.localChangedAt[account.id] ?? .distantPast)
            ))
        }
        return setups
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

    @discardableResult
    private func persistState() -> Bool {
        guard let keychain else { return true }
        do {
            let data = try ConfigurationSyncCodec.encoder().encode(state)
            try keychain.save(String(decoding: data, as: UTF8.self), forKey: .configurationSync)
            return true
        } catch {
            syncLogger.error("Could not persist sync state: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}
