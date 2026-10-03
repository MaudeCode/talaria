import Foundation
import Observation
import UserNotifications
import TalariaKit

/// Backs the read-only Providers status screen and Insights quota section.
/// Provider-key writes remain server-side; the only client persistence here is
/// the sanitized app-group snapshot consumed by widgets and sidebar shortcuts.
@MainActor
@Observable
final class ProvidersViewModel {
    /// Server order is preserved: upstream already sorts active-first, then
    /// custom providers, then key-holders, then the rest.
    private(set) var providers: [ProviderSummary] = []
    private(set) var activeProviderID: String?
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var quotaSources: [ProviderQuotaSource] = []
    private(set) var hasStableQuotaSources = false
    private(set) var isQuotaLoading = false
    private(set) var refreshingQuotaSourceIDs: Set<String> = []
    private(set) var quotaErrorMessage: String?
    private(set) var quotaProfileID: String?
    private(set) var quotaScopeID: String?

    private let client: APIClient
    private let quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore?
    private let reloadQuotaWidgets: () -> Void
    private let quotaServer: URL
    private let quotaServerLabel: String

    /// Monotonic token identifying the most recent `load()` call. `load()` has
    /// three overlapping entry points (`.task`, `.refreshable`, "Try Again"), so
    /// an older in-flight request must not overwrite a newer response or clear
    /// `isLoading` while the newer request is still pending (#42 Codex review).
    private var loadGeneration = 0
    private var quotaLoadGeneration = 0

    init(
        server: URL,
        client: APIClient? = nil,
        quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore? = nil,
        reloadQuotaWidgets: @escaping () -> Void = {
            ProviderQuotaWidgetSnapshotStore.reloadTimelines()
        }
    ) {
        self.client = client ?? APIClient(baseURL: server)
        self.quotaSnapshotStore = quotaSnapshotStore ?? (client == nil ? ProviderQuotaWidgetSnapshotStore() : nil)
        self.reloadQuotaWidgets = reloadQuotaWidgets
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
           snapshot.sources.allSatisfy({ $0.scopeLabel.hasPrefix("\(self.quotaServerLabel) · ") }) {
            // Older builds cached `removed` rows; Insights renders only live server sources.
            quotaSources = snapshot.sources.filter { $0.status != "removed" }.map(Self.cachedQuotaSource)
            hasStableQuotaSources = true
            quotaScopeID = snapshot.sources.first?.scopeID
        }
    }

    func load() async {
        loadGeneration += 1
        let generation = loadGeneration

        isLoading = true
        errorMessage = nil

        do {
            let response = try await client.providers()
            guard generation == loadGeneration else { return }
            providers = response.providers ?? []
            activeProviderID = Self.normalizedProviderID(response.activeProvider)
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

    func loadQuotas(refresh: Bool = false) async {
        quotaLoadGeneration += 1
        let generation = quotaLoadGeneration
        isQuotaLoading = true
        quotaErrorMessage = nil

        do {
            let response = try await client.providerQuotas(refresh: refresh)
            guard generation == quotaLoadGeneration else { return }
            applyQuotaResponse(response)
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

    func cancelLoads() {
        loadGeneration += 1
        quotaLoadGeneration += 1
        isLoading = false
        isQuotaLoading = false
        refreshingQuotaSourceIDs.removeAll()
    }

    func refreshQuotasPeriodically(
        every interval: Duration = ProviderQuotaRefreshInterval.defaultValue.duration
    ) async {
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: interval)
            } catch {
                return
            }
            await loadQuotas(refresh: true)
        }
    }

    func refreshQuota(sourceID: String) async {
        guard hasStableQuotaSources, !sourceID.isEmpty else { return }
        let generation = quotaLoadGeneration
        let profileID = quotaProfileID
        let scopeID = quotaScopeID
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
            if response.missingSource {
                quotaSources.removeAll { $0.id == sourceID }
            } else if let refreshed = response.sources.first(where: { $0.id == sourceID }),
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
    private func applyQuotaResponse(_ response: ProviderQuotasResponse) {
        quotaSources = response.sources
        hasStableQuotaSources = true
        quotaProfileID = response.profileID
        quotaScopeID = response.scopeID
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
                updatedSourceIDs: updatedSourceIDs
              )
        else { return }
        reloadQuotaWidgets()
        Task { await ProviderQuotaAlertService.evaluate(widgetSources) }
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

    private static func cachedQuotaSource(_ source: ProviderQuotaWidgetSource) -> ProviderQuotaSource {
        ProviderQuotaSource(
            id: source.sourceID,
            providerID: source.providerID ?? "",
            providerLabel: source.providerLabel,
            accountLabel: source.accountLabel,
            isActiveProvider: source.isActiveProvider,
            supported: source.status != "unsupported",
            status: source.status,
            plan: source.plan,
            windows: source.windows,
            quota: source.quota,
            retryAfter: source.retryAfter,
            fetchedAt: source.fetchedAt
        )
    }

    func isActive(_ provider: ProviderSummary) -> Bool {
        guard let active = activeProviderID,
              let id = Self.normalizedProviderID(provider.id)
        else {
            return false
        }

        return id == active
    }

    // MARK: - Presentation helpers (pure, testable)

    /// `active_provider` comes from config (`model.provider`) while entry `id`s are
    /// canonical slugs — trim and lowercase both sides so cosmetic differences
    /// don't hide the active badge.
    static func normalizedProviderID(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !trimmed.isEmpty
        else {
            return nil
        }

        return trimmed
    }

    static func displayName(for provider: ProviderSummary) -> String {
        if let name = trimmedNonEmpty(provider.displayName) {
            return name
        }

        if let id = trimmedNonEmpty(provider.id) {
            return id
        }

        return String(localized: "Unknown provider")
    }

    /// Short technical badge naming where a configured key came from. Collapses the
    /// upstream `key_source` vocabulary (`env_file`/`env_var`/`env` → env,
    /// `oauth`/`token` → OAuth, `config_yaml`/`config` → config); unknown future
    /// values pass through verbatim rather than being hidden. `nil` when the
    /// provider has no key — the badge only ever describes an existing credential.
    static func keySourceBadge(for provider: ProviderSummary) -> String? {
        guard provider.hasKey == true else {
            return nil
        }

        let raw = provider.keySource?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""

        switch raw {
        case "", "none":
            return nil
        case "env_file", "env_var", "env":
            return "env"
        case "oauth", "token":
            return "OAuth"
        case "config_yaml", "config":
            return "config"
        default:
            return raw
        }
    }

    static func authErrorText(for provider: ProviderSummary) -> String? {
        trimmedNonEmpty(provider.authError)
    }

    /// Catalog size to advertise on the models disclosure: `models_total` reflects
    /// the complete catalog even when `models` is trimmed to a featured subset, so
    /// prefer it whenever it is larger than the visible list.
    static func modelCount(for provider: ProviderSummary) -> Int {
        max(provider.modelsTotal ?? 0, provider.models?.count ?? 0)
    }

    /// Non-nil only when the server trimmed the model list (`models_total` exceeds
    /// the entries actually sent) — drives the "Showing X of Y models" footer.
    static func truncatedModelInfo(for provider: ProviderSummary) -> (shown: Int, total: Int)? {
        let shown = provider.models?.count ?? 0

        guard let total = provider.modelsTotal, shown > 0, total > shown else {
            return nil
        }

        return (shown: shown, total: total)
    }

    static func quotaUsedPercent(_ window: ProviderQuotaWindow) -> Double? {
        ProviderQuotaPresentation.usedPercent(window)
    }

    static func quotaPercentText(_ window: ProviderQuotaWindow, locale: Locale = .current) -> String? {
        guard let used = quotaUsedPercent(window) else { return nil }
        return String(localized: "\(insightsFormattedPercent(used, locale: locale)) used")
    }

    private static func trimmedNonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

private enum ProviderQuotaAlertService {
    private enum Level: String, Codable {
        case warning
        case critical

        var rank: Int { self == .critical ? 2 : 1 }
    }

    static func evaluate(_ sources: [ProviderQuotaWidgetSource]) async {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: ProviderQuotaAlertSettings.isEnabledKey),
              await notificationsAreAllowed()
        else { return }

        let appGroup = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
        let settings = ProviderQuotaEvaluationSettings.stored(defaults: appGroup)
        let aliasesData = appGroup.data(forKey: ProviderQuotaDisplaySettings.aliasesKey) ?? Data()
        var previous = decodedStates(defaults.data(forKey: ProviderQuotaAlertSettings.stateKey))
        let currentSourceIDs = Set(sources.filter { $0.status != "removed" }.map(\.sourceID))
        previous = previous.filter { currentSourceIDs.contains($0.key) }

        for source in sources where source.status != "removed" {
            let state = ProviderQuotaPresentation.state(for: source, settings: settings, at: source.freshnessDate)
            let level: Level? = switch state.urgency {
            case .critical: .critical
            case .warning: .warning
            default: nil
            }
            let oldLevel = previous[source.sourceID].flatMap(Level.init(rawValue:))
            if let level {
                previous[source.sourceID] = level.rawValue
                if oldLevel == nil || level.rank > (oldLevel?.rank ?? 0) {
                    await schedule(level, source: source, aliasesData: aliasesData, remaining: state.remainingPercent)
                }
            } else {
                previous.removeValue(forKey: source.sourceID)
            }
        }

        defaults.set(try? JSONEncoder().encode(previous), forKey: ProviderQuotaAlertSettings.stateKey)
    }

    private static func schedule(
        _ level: Level,
        source: ProviderQuotaWidgetSource,
        aliasesData: Data,
        remaining: Double?
    ) async {
        let name = ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: aliasesData
        )
        let content = UNMutableNotificationContent()
        content.title = level == .critical
            ? String(localized: "\(name) quota critical")
            : String(localized: "\(name) quota warning")
        content.body = remaining.map {
            String(localized: "\($0.formatted(.number.precision(.fractionLength(0...1))))% remaining. Open Talaria for current pace and reset details.")
        } ?? String(localized: "Open Talaria for current quota details.")
        content.sound = .default
        content.userInfo = ["quota_source_id": source.sourceID]
        let request = UNNotificationRequest(
            identifier: "provider-quota-\(source.sourceID)-\(level.rawValue)",
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }

    private static func notificationsAreAllowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private static func decodedStates(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

}
