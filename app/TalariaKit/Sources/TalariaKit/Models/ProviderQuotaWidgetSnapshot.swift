import Foundation
import WidgetKit

public struct ProviderQuotaWidgetSource: Codable, Equatable, Identifiable, Sendable {
    public var id: String { sourceID }
    public var freshnessDate: Date { ProviderQuotaDateParser.date(from: fetchedAt) ?? cachedAt }

    public let sourceID: String
    public let scopeID: String
    public let scopeLabel: String
    let cachedAt: Date
    public let providerID: String?
    public let providerLabel: String
    public let accountLabel: String
    public let isActiveProvider: Bool
    public let status: String
    public let plan: String?
    public let windows: [ProviderQuotaWindow]
    public let quota: ProviderQuotaAmount?
    public let retryAfter: String?
    public let fetchedAt: String?

    public init(
        sourceID: String,
        scopeID: String = "qscope_default",
        scopeLabel: String = "Default",
        cachedAt: Date = Date(),
        providerID: String? = nil,
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
        self.providerID = providerID
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

    public init(_ source: ProviderQuotaSource, scopeID: String, scopeLabel: String) {
        self.init(
            sourceID: source.id,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            providerID: source.providerID,
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
            providerID: providerID,
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

public struct ProviderQuotaWidgetSnapshot: Codable, Equatable, Sendable {
    public static let staleAfter: TimeInterval = 15 * 60

    let updatedAt: Date
    public let sources: [ProviderQuotaWidgetSource]

    public init(updatedAt: Date, sources: [ProviderQuotaWidgetSource]) {
        self.updatedAt = updatedAt
        self.sources = sources
    }

    func isStale(at date: Date = Date(), maximumAge: TimeInterval = staleAfter) -> Bool {
        date.timeIntervalSince(updatedAt) > maximumAge
    }
}

public struct ProviderQuotaWidgetSnapshotStore {
    public static let widgetKind = "ProviderQuotaWidget"
    public static let paceWidgetKind = "ProviderQuotaPaceWidget"
    static let storageKey = "providerQuotaWidgetSnapshot.v1"

    private let defaults: UserDefaults?

    public init(defaults: UserDefaults? = UserDefaults(suiteName: Self.appGroupIdentifier)) {
        self.defaults = defaults
    }

    @discardableResult
    public func save(
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

    public func load() -> ProviderQuotaWidgetSnapshot? {
        guard let data = defaults?.data(forKey: Self.storageKey) else { return nil }
        return try? JSONDecoder().decode(ProviderQuotaWidgetSnapshot.self, from: data)
    }

    @discardableResult
    public func clear() -> Bool {
        guard let defaults, defaults.object(forKey: Self.storageKey) != nil else { return false }
        defaults.removeObject(forKey: Self.storageKey)
        return true
    }

    public static var appGroupIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "TalariaAppGroupIdentifier") as? String
            ?? "group.dev.kil.talaria"
    }

    public static var appGroupDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }

    public static func reloadTimelines() {
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        WidgetCenter.shared.reloadTimelines(ofKind: paceWidgetKind)
    }
}
