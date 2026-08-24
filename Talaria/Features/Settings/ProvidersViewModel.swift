import Foundation
import Observation
import WidgetKit

/// Backs the read-only Providers status screen (#26). Loads `GET /api/providers`
/// once per appearance and exposes pure, testable presentation helpers — no
/// write operations by design (key set/delete stays a server-side concern).
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
    private(set) var quotaCapabilityMessage: String?
    private(set) var quotaProfileID: String?
    private(set) var quotaScopeID: String?

    private let client: APIClient
    private let quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore?
    private let reloadQuotaWidgets: () -> Void
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
            WidgetCenter.shared.reloadTimelines(ofKind: ProviderQuotaWidgetSnapshotStore.widgetKind)
        }
    ) {
        self.client = client ?? APIClient(baseURL: server)
        self.quotaSnapshotStore = quotaSnapshotStore ?? (client == nil ? ProviderQuotaWidgetSnapshotStore() : nil)
        self.reloadQuotaWidgets = reloadQuotaWidgets
        let storedLabel = ServerRegistry.shared.servers
            .first(where: { $0.id == server.absoluteString })?
            .displayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let storedLabel, !storedLabel.isEmpty, !storedLabel.contains("://") {
            self.quotaServerLabel = storedLabel
        } else {
            self.quotaServerLabel = String(localized: "Server")
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
            applyStableQuotaResponse(response)
        } catch APIError.http(let statusCode, _) where statusCode == 404 {
            do {
                let legacy = try await client.activeProviderQuota()
                guard generation == quotaLoadGeneration else { return }
                quotaSources = Self.legacyQuotaSources(legacy)
                hasStableQuotaSources = false
                quotaProfileID = nil
                quotaScopeID = nil
                clearQuotaWidgetSnapshot()
                quotaCapabilityMessage = String(
                    localized: "This server supports active-provider quota only. Multi-account sources require the companion server update."
                )
            } catch {
                guard generation == quotaLoadGeneration else { return }
                quotaErrorMessage = error.localizedDescription
            }
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
            if response.missingSource {
                quotaSources = quotaSources.map { $0.id == sourceID ? $0.removed() : $0 }
            } else if let refreshed = response.sources.first(where: { $0.id == sourceID }) {
                if let index = quotaSources.firstIndex(where: { $0.id == sourceID }) {
                    quotaSources[index] = refreshed
                } else {
                    quotaSources.append(refreshed)
                }
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

    private func applyStableQuotaResponse(_ response: ProviderQuotasResponse) {
        let sameProfile = quotaProfileID == nil || quotaProfileID == response.profileID
        let incomingIDs = Set(response.sources.map(\.id))
        let removed = sameProfile && hasStableQuotaSources
            ? quotaSources.filter { !incomingIDs.contains($0.id) }.map { $0.removed() }
            : []
        quotaSources = response.sources + removed
        hasStableQuotaSources = response.version == 1
        quotaProfileID = response.profileID
        quotaScopeID = response.scopeID ?? quotaScopeID
        quotaCapabilityMessage = hasStableQuotaSources
            ? nil
            : String(localized: "This server returned quota data without stable source identity.")
        if hasStableQuotaSources {
            persistQuotaWidgetSnapshot()
        }
    }

    private func persistQuotaWidgetSnapshot(updatedSourceIDs: Set<String>? = nil) {
        guard let quotaSnapshotStore,
              let quotaScopeID,
              let quotaProfileID,
              quotaSnapshotStore.save(
                scopeID: quotaScopeID,
                sources: quotaSources.map {
                    ProviderQuotaWidgetSource(
                        $0,
                        scopeID: quotaScopeID,
                        scopeLabel: "\(quotaServerLabel) · \(quotaProfileID)"
                    )
                },
                updatedSourceIDs: updatedSourceIDs
              )
        else {
            return
        }
        reloadQuotaWidgets()
    }

    private func clearQuotaWidgetSnapshot() {
        guard quotaSnapshotStore?.clear() == true else { return }
        reloadQuotaWidgets()
    }

    private static func legacyQuotaSources(_ response: LegacyProviderQuotaResponse) -> [ProviderQuotaSource] {
        let providerID = response.provider ?? "unknown"
        let providerLabel = response.displayName ?? response.provider ?? String(localized: "Provider")
        let limits = response.accountLimits
        if let credentials = limits?.pool?.credentials, !credentials.isEmpty {
            return credentials.enumerated().map { index, credential in
                ProviderQuotaSource(
                    id: "legacy-active-\(index)",
                    providerID: providerID,
                    providerLabel: providerLabel,
                    accountLabel: credential.label ?? providerLabel,
                    isActiveProvider: true,
                    supported: response.supported ?? false,
                    status: credential.status ?? response.status ?? "unavailable",
                    plan: credential.plan,
                    windows: credential.windows ?? [],
                    quota: response.quota,
                    details: credential.details ?? [],
                    unavailableReason: credential.unavailableReason,
                    retryAfter: credential.retryAfter,
                    fetchedAt: credential.fetchedAt,
                    message: response.message
                )
            }
        }
        return [
            ProviderQuotaSource(
                id: "legacy-active",
                providerID: providerID,
                providerLabel: providerLabel,
                accountLabel: providerLabel,
                isActiveProvider: true,
                supported: response.supported ?? false,
                status: response.status ?? "unavailable",
                plan: limits?.plan,
                windows: limits?.windows ?? [],
                quota: response.quota,
                details: limits?.details ?? [],
                unavailableReason: limits?.unavailableReason,
                fetchedAt: limits?.fetchedAt,
                message: response.message
            )
        ]
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
