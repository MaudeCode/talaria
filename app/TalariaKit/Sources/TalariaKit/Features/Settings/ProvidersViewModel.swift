import Foundation
import Observation
import UserNotifications

/// Backs the read-only Providers status screen and Insights quota section.
/// Provider-key writes remain server-side; the only client persistence here is
/// the sanitized app-group snapshot consumed by widgets and sidebar shortcuts.
@MainActor
@Observable
public final class ProvidersViewModel {
    /// Server order is preserved: upstream already sorts active-first, then
    /// custom providers, then key-holders, then the rest.
    public private(set) var providers: [ProviderSummary] = []
    private(set) var activeProviderID: String?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var quotaSources: [ProviderQuotaSource] = []
    public private(set) var hasStableQuotaSources = false
    /// True once a server list arrived; a cached snapshot alone leaves it false.
    public private(set) var hasServerQuotaSources = false
    public private(set) var isQuotaLoading = false
    public private(set) var refreshingQuotaSourceIDs: Set<String> = []
    public private(set) var quotaErrorMessage: String?
    public private(set) var quotaProfileID: String?
    public private(set) var quotaScopeID: String?
    private var quotaSourceGeneration: String?

    private let client: APIClient
    private let quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore?
    private let reloadQuotaWidgets: () -> Void
    /// Runs only after a successful server response, with the ids it refreshed (nil: all); never from the cache.
    private let evaluateQuotaAlerts: ([ProviderQuotaWidgetSource], Set<String>?) -> Void
    private let quotaServer: URL
    private let quotaServerLabel: String

    /// Monotonic token identifying the most recent `load()` call. `load()` has
    /// three overlapping entry points (`.task`, `.refreshable`, "Try Again"), so
    /// an older in-flight request must not overwrite a newer response or clear
    /// `isLoading` while the newer request is still pending (#42 Codex review).
    private var loadGeneration = 0
    private var quotaLoadGeneration = 0
    /// Orders every quota request by start, so a slow full load cannot replace a
    /// source that a later targeted refresh already updated.
    private var quotaRequestSequence = 0
    private var targetedQuotaRefreshSequences: [String: Int] = [:]
    /// The shared refresh schedule: every view that keeps quotas fresh reads these,
    /// so overlapping owners wait for the same due time instead of polling twice.
    private var lastForcedQuotaRefreshStart: ContinuousClock.Instant?
    private var lastForcedQuotaRefreshSuccess: ContinuousClock.Instant?

    /// The App builds its model through `ProvidersViewModel.app(server:)`, which passes the quota alert evaluation:
    /// that reads the widget presentation settings, which live in the App target.
    public init(
        server: URL,
        client: APIClient? = nil,
        quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore? = nil,
        reloadQuotaWidgets: @escaping () -> Void = {
            ProviderQuotaWidgetSnapshotStore.reloadTimelines()
        },
        evaluateQuotaAlerts: @escaping ([ProviderQuotaWidgetSource], Set<String>?) -> Void = { _, _ in }
    ) {
        self.client = client ?? APIClient(baseURL: server)
        self.quotaSnapshotStore = quotaSnapshotStore ?? (client == nil ? ProviderQuotaWidgetSnapshotStore() : nil)
        self.reloadQuotaWidgets = reloadQuotaWidgets
        self.evaluateQuotaAlerts = evaluateQuotaAlerts
        self.quotaServer = server
        let storedLabel = ServerRegistry.shared.servers
            .first(where: { $0.id == server.absoluteString })?
            .displayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let storedLabel, !storedLabel.isEmpty, !storedLabel.contains("://") {
            self.quotaServerLabel = storedLabel
        } else {
            self.quotaServerLabel = String(localized: "Server")
        }
        if let snapshot = self.quotaSnapshotStore?.load(),
           !snapshot.sources.isEmpty,
           snapshot.serverID == ResponseCache.serverIdentity(for: server),
           snapshot.profileID == (ActiveServerProfile.name(for: server) ?? "default") {
            // Older builds cached `removed` rows; Insights renders only live server sources.
            quotaSources = snapshot.sources.filter { $0.status != "removed" }.map(\.quotaSource)
            hasStableQuotaSources = true
            quotaScopeID = snapshot.sources.first?.scopeID
            quotaProfileID = snapshot.profileID
            quotaSourceGeneration = snapshot.sourceGeneration
        }
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration

        isLoading = true
        errorMessage = nil

        do {
            let response = try await client.providers()
            guard generation == loadGeneration else { return }
            providers = response.providers ?? []
            activeProviderID = response.activeProvider
            errorMessage = response.availability?.unavailableReason
        } catch is CancellationError {
            // The owning view was dismissed (or the refresh gesture was torn
            // down) mid-request — don't surface "cancelled" as a load error.
        } catch let error as URLError where error.code == .cancelled {
            // Same cancellation, surfaced through URLSession.
        } catch {
            guard generation == loadGeneration else { return }
            errorMessage = error.localizedDescription
        }

        // A newer load owns the loading state now — leave it alone.
        guard generation == loadGeneration else { return }
        isLoading = false
    }

    public func loadQuotas(refresh: Bool = false) async {
        quotaLoadGeneration += 1
        let generation = quotaLoadGeneration
        quotaRequestSequence += 1
        let sequence = quotaRequestSequence
        if refresh { lastForcedQuotaRefreshStart = ContinuousClock.now }
        isQuotaLoading = true
        quotaErrorMessage = nil

        do {
            let response = try await client.providerQuotas(refresh: refresh)
            guard generation == quotaLoadGeneration else { return }
            applyQuotaResponse(response, sequence: sequence)
            if refresh && response.hasAuthoritativeMembership { lastForcedQuotaRefreshSuccess = ContinuousClock.now }
        } catch is CancellationError {
            // The view was dismissed while quota was loading.
        } catch let error as URLError where error.code == .cancelled {
            // Same cancellation surfaced through URLSession.
        } catch {
            guard generation == quotaLoadGeneration else { return }
            quotaErrorMessage = error.localizedDescription
        }

        guard generation == quotaLoadGeneration else { return }
        isQuotaLoading = false
    }

    public func cancelLoads() {
        loadGeneration += 1
        quotaLoadGeneration += 1
        isLoading = false
        isQuotaLoading = false
        refreshingQuotaSourceIDs.removeAll()
    }

    /// Keeps quotas fresh while the caller's task runs. Joining reconciles at once
    /// unless a forced refresh succeeded within `interval` or a load is in flight;
    /// after that, every owner waits for the shared next due time.
    public func refreshQuotasPeriodically(
        every interval: Duration = ProviderQuotaRefreshInterval.defaultValue.duration,
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async {
        let isStale = lastForcedQuotaRefreshSuccess.map { ContinuousClock.now - $0 >= interval } ?? true
        if isStale, !isQuotaLoading {
            await loadQuotas(refresh: true)
        }
        while !Task.isCancelled {
            let wait = lastForcedQuotaRefreshStart.map { $0 + interval - ContinuousClock.now } ?? .zero
            if wait > .zero {
                do {
                    try await sleep(wait)
                } catch {
                    return
                }
                continue
            }
            await loadQuotas(refresh: true)
        }
    }

    /// One account's refresh; a server without stable source IDs can only refresh the whole list.
    public func refreshQuotaSource(_ sourceID: String) async {
        if hasStableQuotaSources {
            await refreshQuota(sourceID: sourceID)
        } else {
            await loadQuotas(refresh: true)
        }
    }

    func refreshQuota(sourceID: String) async {
        guard hasStableQuotaSources, !sourceID.isEmpty else { return }
        let generation = quotaLoadGeneration
        let profileID = quotaProfileID
        let scopeID = quotaScopeID
        quotaRequestSequence += 1
        let sequence = quotaRequestSequence
        refreshingQuotaSourceIDs.insert(sourceID)
        quotaErrorMessage = nil
        defer { refreshingQuotaSourceIDs.remove(sourceID) }

        do {
            let response = try await client.providerQuotas(sourceID: sourceID, refresh: true)
            guard generation == quotaLoadGeneration,
                  profileID == quotaProfileID,
                  scopeID == quotaScopeID,
                  response.scopeID == nil || response.scopeID == scopeID
            else { return }
            // The server list owns which rows exist: a targeted read replaces its own row
            // or drops it when missing, and never adds a row the full list lacks.
            if response.availability?.generation != quotaSourceGeneration {
                await loadQuotas()
                return
            }
            quotaErrorMessage = response.availability?.unavailableReason
            targetedQuotaRefreshSequences[sourceID] = sequence
            if response.hasAuthoritativeMembership && response.missingSource {
                quotaSources.removeAll { $0.id == sourceID }
            } else if let refreshed = response.retainingUnconfirmedSources(quotaSources, scopeID: quotaScopeID, generation: quotaSourceGeneration).first(where: { $0.id == sourceID }),
                      let index = quotaSources.firstIndex(where: { $0.id == sourceID }) {
                quotaSources[index] = refreshed
            }
            persistQuotaWidgetSnapshot(updatedSourceIDs: [sourceID])
        } catch is CancellationError {
            // The row disappeared while its refresh was running.
        } catch let error as URLError where error.code == .cancelled {
            // Same cancellation surfaced through URLSession.
        } catch {
            guard generation == quotaLoadGeneration, profileID == quotaProfileID else { return }
            quotaErrorMessage = error.localizedDescription
        }
    }

    /// The server's `sources` is the whole list, unique by source ID and already ordered.
    /// A targeted refresh that started after this load already holds its source's newer
    /// state, kept or dropped, even where this older list says otherwise.
    private func applyQuotaResponse(_ response: ProviderQuotasResponse, sequence: Int) {
        let sameScope = quotaProfileID == response.profileID && quotaScopeID == response.scopeID
        let sameGeneration = quotaSourceGeneration == response.availability?.generation
        quotaErrorMessage = response.availability?.unavailableReason
        let newerIDs = sameScope && sameGeneration
            ? Set(targetedQuotaRefreshSequences.filter { $0.value > sequence }.keys)
            : []
        let current = Dictionary(quotaSources.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let incoming = response.retainingUnconfirmedSources(quotaSources, scopeID: quotaScopeID, generation: quotaSourceGeneration)
        let incomingIDs = Set(incoming.map(\.id))
        quotaSources = incoming.compactMap { newerIDs.contains($0.id) ? current[$0.id] : $0 }
            + quotaSources.filter { newerIDs.contains($0.id) && !incomingIDs.contains($0.id) }
        targetedQuotaRefreshSequences = targetedQuotaRefreshSequences.filter { $0.value > sequence }
        hasStableQuotaSources = true
        hasServerQuotaSources = true
        quotaProfileID = response.profileID
        quotaScopeID = response.scopeID
        quotaSourceGeneration = response.availability?.generation
        persistQuotaWidgetSnapshot()
    }

    private func persistQuotaWidgetSnapshot(updatedSourceIDs: Set<String>? = nil) {
        persistWidgetRefreshCredentials()
        guard let quotaSnapshotStore, let quotaScopeID, let quotaProfileID else { return }
        let widgetSources = quotaSources.map {
            ProviderQuotaWidgetSource(
                $0,
                scopeID: quotaScopeID,
                scopeLabel: "\(quotaServerLabel) · \(quotaProfileID)"
            )
        }
        guard quotaSnapshotStore.save(
                scopeID: quotaScopeID,
                sources: widgetSources,
                updatedSourceIDs: updatedSourceIDs,
                serverID: ResponseCache.serverIdentity(for: quotaServer),
                profileID: quotaProfileID,
                sourceGeneration: quotaSourceGeneration
              )
        else { return }
        reloadQuotaWidgets()
        evaluateQuotaAlerts(widgetSources, updatedSourceIDs)
    }

    private func persistWidgetRefreshCredentials() {
        guard quotaSnapshotStore != nil else { return }
        let headers: [ProviderQuotaWidgetRefreshHeader] = CustomHeaderStore.shared.snapshot().compactMap { header in
            guard header.isApplicable else { return nil }
            return ProviderQuotaWidgetRefreshHeader(
                name: header.sanitizedName,
                value: header.sanitizedValue
            )
        }
        let cookies = (ServerCookieStore.shared.storage(for: quotaServer).cookies(for: quotaServer) ?? [])
            .map(ProviderQuotaWidgetRefreshCookie.init)
        let refreshInterval = UserDefaults.standard.object(
            forKey: ProviderQuotaRefreshInterval.storageKey
        ) as? Int ?? ProviderQuotaRefreshInterval.defaultValue.rawValue
        _ = ProviderQuotaWidgetRefreshCredentialStore.save(
            ProviderQuotaWidgetRefreshCredentials(
                serverURLString: quotaServer.absoluteString,
                serverLabel: quotaServerLabel,
                refreshIntervalSeconds: refreshInterval,
                headers: headers,
                cookies: cookies
            )
        )
    }


    /// The server marks the active card (TAL-603). A pre-TAL-603 server omits `is_active`; delete the
    /// exact-match fallback once every supported server ships the field.
    public func isActive(_ provider: ProviderSummary) -> Bool {
        provider.isActive ?? (provider.id != nil && provider.id == activeProviderID)
    }

    // MARK: - Presentation helpers (pure, testable)

    /// Key for the device-local Insights visibility and rename preferences.
    public static func normalizedProviderID(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !trimmed.isEmpty
        else {
            return nil
        }

        return trimmed
    }

    public static func displayName(for provider: ProviderSummary) -> String {
        if let name = trimmedNonEmpty(provider.displayName) {
            return name
        }

        if let id = trimmedNonEmpty(provider.id) {
            return id
        }

        return String(localized: "Unknown provider")
    }

    /// Short technical badge for the server's `key_source_kind` (TAL-603); `other` shows the raw
    /// `key_source`. `nil` when the server sends no kind.
    public static func keySourceBadge(for provider: ProviderSummary) -> String? {
        switch provider.keySourceKind {
        case "oauth":
            return "OAuth"
        case "other":
            return provider.keySource
        default:
            return provider.keySourceKind
        }
    }

    public static func authErrorText(for provider: ProviderSummary) -> String? {
        trimmedNonEmpty(provider.authError)
    }

    /// Catalog size to advertise on the models disclosure: the server's `models_total` (TAL-603). A pre-TAL-603
    /// server (no `is_active`) can report fewer than it lists; delete that guard once every supported server ships the field.
    public static func modelCount(for provider: ProviderSummary) -> Int {
        guard provider.isActive == nil else { return provider.modelsTotal ?? 0 }
        return max(provider.modelsTotal ?? 0, provider.models?.count ?? 0)
    }

    /// Non-nil only when the server trimmed the model list (`models_total` exceeds
    /// the entries actually sent) — drives the "Showing X of Y models" footer.
    public static func truncatedModelInfo(for provider: ProviderSummary) -> (shown: Int, total: Int)? {
        let shown = provider.models?.count ?? 0

        guard let total = provider.modelsTotal, shown > 0, total > shown else {
            return nil
        }

        return (shown: shown, total: total)
    }

    private static func trimmedNonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

public enum ProviderQuotaAlertService {
    public enum Level: String, Codable {
        case warning
        case critical

        var rank: Int { self == .critical ? 2 : 1 }
    }

    public struct Preferences: Equatable {
        var warning = ProviderQuotaAlertSettings.defaultWarningEnabled
        var critical = ProviderQuotaAlertSettings.defaultCriticalEnabled
        var criticalTimeSensitive = ProviderQuotaAlertSettings.defaultCriticalTimeSensitive

        public static func stored(defaults: UserDefaults) -> Preferences {
            func bool(_ key: String, _ fallback: Bool) -> Bool { defaults.object(forKey: key) as? Bool ?? fallback }
            let critical = bool(ProviderQuotaAlertSettings.criticalEnabledKey, ProviderQuotaAlertSettings.defaultCriticalEnabled)
            return Preferences(
                warning: bool(ProviderQuotaAlertSettings.warningEnabledKey, ProviderQuotaAlertSettings.defaultWarningEnabled),
                critical: critical,
                criticalTimeSensitive: critical && bool(
                    ProviderQuotaAlertSettings.criticalTimeSensitiveKey,
                    ProviderQuotaAlertSettings.defaultCriticalTimeSensitive
                )
            )
        }

        func allows(_ level: Level) -> Bool {
            level == .critical ? critical : warning
        }
    }

    /// The alerts server urgency raises: entering warning or critical, or escalating from warning to critical.
    /// `previous` holds each source's last alerted level; a source back below warning clears it.
    public static func transitions(
        _ urgencies: [(sourceID: String, urgency: ProviderQuotaUrgency)],
        previous: [String: String],
        preferences: Preferences
    ) -> (alerts: [String: Level], states: [String: String]) {
        var states = previous
        var alerts: [String: Level] = [:]
        for (sourceID, urgency) in urgencies {
            let level: Level? = switch urgency {
            case .critical: .critical
            case .warning: .warning
            default: nil
            }
            let oldLevel = previous[sourceID].flatMap(Level.init(rawValue:))
            if let level {
                states[sourceID] = level.rawValue
                if level.rank > (oldLevel?.rank ?? 0), preferences.allows(level) { alerts[sourceID] = level }
            } else {
                states.removeValue(forKey: sourceID)
            }
        }
        return (alerts, states)
    }

    public static func request(
        _ level: Level,
        sourceID: String,
        name: String,
        remaining: Double?,
        preferences: Preferences
    ) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = level == .critical
            ? String(localized: "\(name) quota critical")
            : String(localized: "\(name) quota warning")
        content.body = remaining.map {
            String(localized: "\($0.formatted(.number.precision(.fractionLength(0...1))))% remaining. Open Talaria for current pace and reset details.")
        } ?? String(localized: "Open Talaria for current quota details.")
        content.sound = .default
        content.userInfo = ["quota_source_id": sourceID]
        content.categoryIdentifier = ProviderQuotaAlertSettings.categoryIdentifier
        content.interruptionLevel = level == .critical && preferences.criticalTimeSensitive ? .timeSensitive : .active
        return UNNotificationRequest(
            identifier: "provider-quota-\(sourceID)-\(level.rawValue)",
            content: content,
            trigger: nil
        )
    }
}
