import AppIntents
import Foundation

struct ProviderQuotaWidgetSource: Codable, Equatable, Identifiable, Sendable {
    var id: String { sourceID }

    let sourceID: String
    let scopeID: String
    let scopeLabel: String
    let cachedAt: Date
    let providerLabel: String
    let accountLabel: String
    let isActiveProvider: Bool
    let status: String
    let plan: String?
    let windows: [ProviderQuotaWindow]
    let quota: ProviderQuotaAmount?
    let retryAfter: String?
    let fetchedAt: String?

    init(
        sourceID: String,
        scopeID: String = "qscope_default",
        scopeLabel: String = "Default",
        cachedAt: Date = Date(),
        providerLabel: String,
        accountLabel: String,
        isActiveProvider: Bool,
        status: String,
        plan: String?,
        windows: [ProviderQuotaWindow],
        quota: ProviderQuotaAmount? = nil,
        retryAfter: String?,
        fetchedAt: String?
    ) {
        self.sourceID = sourceID
        self.scopeID = scopeID
        self.scopeLabel = scopeLabel
        self.cachedAt = cachedAt
        self.providerLabel = providerLabel
        self.accountLabel = accountLabel
        self.isActiveProvider = isActiveProvider
        self.status = status
        self.plan = plan
        self.windows = windows
        self.quota = quota
        self.retryAfter = retryAfter
        self.fetchedAt = fetchedAt
    }

    init(_ source: ProviderQuotaSource, scopeID: String, scopeLabel: String) {
        self.init(
            sourceID: source.id,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            providerLabel: source.providerLabel,
            accountLabel: source.accountLabel,
            isActiveProvider: source.isActiveProvider,
            status: source.status,
            plan: source.plan,
            windows: source.windows,
            quota: source.quota,
            retryAfter: source.retryAfter,
            fetchedAt: source.fetchedAt
        )
    }

    func withCachedAt(_ cachedAt: Date) -> ProviderQuotaWidgetSource {
        ProviderQuotaWidgetSource(
            sourceID: sourceID,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            cachedAt: cachedAt,
            providerLabel: providerLabel,
            accountLabel: accountLabel,
            isActiveProvider: isActiveProvider,
            status: status,
            plan: plan,
            windows: windows,
            quota: quota,
            retryAfter: retryAfter,
            fetchedAt: fetchedAt
        )
    }
}

struct ProviderQuotaWidgetSnapshot: Codable, Equatable, Sendable {
    static let staleAfter: TimeInterval = 15 * 60

    let updatedAt: Date
    let sources: [ProviderQuotaWidgetSource]

    func isStale(at date: Date = Date(), maximumAge: TimeInterval = staleAfter) -> Bool {
        date.timeIntervalSince(updatedAt) > maximumAge
    }
}

struct ProviderQuotaWidgetSnapshotStore {
    static let widgetKind = "ProviderQuotaWidget"
    static let storageKey = "providerQuotaWidgetSnapshot.v1"

    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = UserDefaults(suiteName: Self.appGroupIdentifier)) {
        self.defaults = defaults
    }

    @discardableResult
    func save(
        scopeID: String,
        sources: [ProviderQuotaWidgetSource],
        updatedSourceIDs: Set<String>? = nil,
        at date: Date = Date()
    ) -> Bool {
        guard sources.allSatisfy({ $0.scopeID == scopeID }) else { return false }
        let previous = Dictionary(uniqueKeysWithValues: (load()?.sources ?? []).map { ($0.sourceID, $0) })
        let persistedSources = sources.map { source in
            guard let updatedSourceIDs,
                  !updatedSourceIDs.contains(source.sourceID),
                  let previous = previous[source.sourceID]
            else {
                return source
            }
            return source.withCachedAt(previous.cachedAt)
        }
        guard let defaults,
              let data = try? JSONEncoder().encode(
                ProviderQuotaWidgetSnapshot(updatedAt: date, sources: persistedSources)
              )
        else {
            return false
        }
        defaults.set(data, forKey: Self.storageKey)
        return true
    }

    func load() -> ProviderQuotaWidgetSnapshot? {
        guard let data = defaults?.data(forKey: Self.storageKey) else { return nil }
        return try? JSONDecoder().decode(ProviderQuotaWidgetSnapshot.self, from: data)
    }

    @discardableResult
    func clear() -> Bool {
        guard let defaults, defaults.object(forKey: Self.storageKey) != nil else { return false }
        defaults.removeObject(forKey: Self.storageKey)
        return true
    }

    static var appGroupIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "TalariaAppGroupIdentifier") as? String
            ?? "group.dev.kil.talaria"
    }
}

enum ProviderQuotaWidgetSelection {
    static func sourceIDs(slotIDs: [String?], capacity: Int) -> [String] {
        slotIDs.prefix(max(0, min(capacity, 4))).compactMap { raw in
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    static func resolve(
        sourceIDs: [String],
        snapshot: ProviderQuotaWidgetSnapshot?
    ) -> [ProviderQuotaWidgetSource?] {
        let byID = Dictionary(uniqueKeysWithValues: (snapshot?.sources ?? []).map { ($0.sourceID, $0) })
        return sourceIDs.map { byID[$0] }
    }
}

enum ProviderQuotaDateParser {
    static func date(from value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return ISO8601DateFormatter().date(from: value) ?? fractional.date(from: value)
    }
}

enum ProviderQuotaPresentation {
    static func usedPercent(_ window: ProviderQuotaWindow) -> Double? {
        if let used = window.usedPercent, used.isFinite { return min(max(used, 0), 100) }
        if let remaining = window.remainingPercent, remaining.isFinite { return min(max(100 - remaining, 0), 100) }
        return nil
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "available": String(localized: "Available")
        case "exhausted": String(localized: "Quota exhausted")
        case "invalid_key", "no_key": String(localized: "Authentication required")
        case "removed": String(localized: "Account removed")
        case "unsupported": String(localized: "Quota not supported")
        case "dead": String(localized: "Credential unavailable")
        default: String(localized: "Quota unavailable")
        }
    }
}

struct ProviderQuotaSourceEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota source")
    static var defaultQuery = ProviderQuotaSourceEntityQuery()

    let id: String
    let name: String
    let providerLabel: String
    let scopeLabel: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(providerLabel) · \(scopeLabel)")
    }

    init(source: ProviderQuotaWidgetSource) {
        id = source.sourceID
        name = source.accountLabel
        providerLabel = source.providerLabel
        scopeLabel = source.scopeLabel
    }
}

struct ProviderQuotaSourceEntityQuery: EntityQuery {
    func entities(for identifiers: [ProviderQuotaSourceEntity.ID]) async throws -> [ProviderQuotaSourceEntity] {
        let wanted = Set(identifiers)
        return currentEntities().filter { wanted.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ProviderQuotaSourceEntity] {
        currentEntities()
    }

    private func currentEntities() -> [ProviderQuotaSourceEntity] {
        (ProviderQuotaWidgetSnapshotStore().load()?.sources ?? [])
            .filter { $0.status != "removed" }
            .map(ProviderQuotaSourceEntity.init)
    }
}

struct ProviderQuotaWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Provider quotas"
    static var description = IntentDescription("Choose the provider accounts shown in this widget.")

    @Parameter(title: "All sizes — Source 1") var source1: ProviderQuotaSourceEntity?
    @Parameter(title: "Medium/Large — Source 2") var source2: ProviderQuotaSourceEntity?
    @Parameter(title: "Large — Source 3") var source3: ProviderQuotaSourceEntity?
    @Parameter(title: "Large — Source 4") var source4: ProviderQuotaSourceEntity?

    var sourceIDs: [String?] {
        [source1?.id, source2?.id, source3?.id, source4?.id]
    }
}
