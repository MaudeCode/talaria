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
    public let unavailableReason: String?
    public let plan: String?
    public let windows: [ProviderQuotaWindow]
    public let quota: ProviderQuotaAmount?
    public let retryAfter: String?
    public let fetchedAt: String?
    // Optional so a v1 snapshot written before TAL-409 still decodes.
    public let paceWindowIndex: Int?
    public let sessionWindowIndex: Int?
    public let weeklyWindowIndex: Int?
    public let computedAt: String?
    // Optional so a snapshot written before TAL-411 still decodes; widgets show it while the server is unreachable.
    public let urgency: ProviderQuotaUrgencyLevels?
    // Optional so a snapshot written before TAL-1533 still decodes.
    public let isStale: Bool?
    public let staleSince: String?

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
        fetchedAt: String?,
        paceWindowIndex: Int? = nil,
        sessionWindowIndex: Int? = nil,
        weeklyWindowIndex: Int? = nil,
        computedAt: String? = nil,
        urgency: ProviderQuotaUrgencyLevels? = nil,
        unavailableReason: String? = nil,
        isStale: Bool? = nil,
        staleSince: String? = nil
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
        self.unavailableReason = unavailableReason
        self.plan = plan
        self.windows = windows
        self.quota = quota
        self.retryAfter = retryAfter
        self.fetchedAt = fetchedAt
        self.paceWindowIndex = paceWindowIndex
        self.sessionWindowIndex = sessionWindowIndex
        self.weeklyWindowIndex = weeklyWindowIndex
        self.computedAt = computedAt
        self.urgency = urgency
        self.isStale = isStale
        self.staleSince = staleSince
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
            fetchedAt: source.fetchedAt,
            paceWindowIndex: source.paceWindowIndex,
            sessionWindowIndex: source.sessionWindowIndex,
            weeklyWindowIndex: source.weeklyWindowIndex,
            computedAt: source.computedAt,
            urgency: source.urgency,
            unavailableReason: source.unavailableReason,
            isStale: source.isStale,
            staleSince: source.staleSince
        )
    }

    public var quotaSource: ProviderQuotaSource {
        let source = self
        return ProviderQuotaSource(
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
            unavailableReason: source.unavailableReason,
            retryAfter: source.retryAfter,
            fetchedAt: source.fetchedAt,
            paceWindowIndex: source.paceWindowIndex,
            sessionWindowIndex: source.sessionWindowIndex,
            weeklyWindowIndex: source.weeklyWindowIndex,
            computedAt: source.computedAt,
            urgency: source.urgency,
            isStale: source.isStale,
            staleSince: source.staleSince
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
            fetchedAt: fetchedAt,
            paceWindowIndex: paceWindowIndex,
            sessionWindowIndex: sessionWindowIndex,
            weeklyWindowIndex: weeklyWindowIndex,
            computedAt: computedAt,
            urgency: urgency,
            unavailableReason: unavailableReason,
            isStale: isStale,
            staleSince: staleSince
        )
    }

    /// The server's stale decision, or a copy shown past its `staleSince` (a widget's cached snapshot).
    public func isStale(at date: Date) -> Bool {
        // Old-server fallback (TAL-1533): the stale status, and 15 minutes after the provider read.
        let since = ProviderQuotaDateParser.date(from: staleSince)
            ?? freshnessDate.addingTimeInterval(ProviderQuotaWidgetSnapshot.staleAfter)
        return (isStale ?? (status == "stale")) || date > since
    }
}

public struct ProviderQuotaWidgetSnapshot: Codable, Equatable, Sendable {
    public static let staleAfter: TimeInterval = 15 * 60

    let updatedAt: Date
    public let sources: [ProviderQuotaWidgetSource]
    public let serverID: String?
    public let profileID: String?
    public let sourceGeneration: String?

    public init(updatedAt: Date, sources: [ProviderQuotaWidgetSource], serverID: String? = nil, profileID: String? = nil, sourceGeneration: String? = nil) {
        self.serverID = serverID
        self.profileID = profileID
        self.sourceGeneration = sourceGeneration
        self.updatedAt = updatedAt
        self.sources = sources
    }

    func isStale(at date: Date = Date(), maximumAge: TimeInterval = staleAfter) -> Bool {
        date.timeIntervalSince(updatedAt) > maximumAge
    }
}

/// `@unchecked Sendable` is safe: the one stored property is immutable and `UserDefaults` is thread-safe.
public struct ProviderQuotaWidgetSnapshotStore: @unchecked Sendable {
    public static let widgetKind = "ProviderQuotaWidget"
    public static let paceWidgetKind = "ProviderQuotaPaceWidget"
    public static let storageKey = "providerQuotaWidgetSnapshot.v1"

    private let defaults: UserDefaults?

    public init(defaults: UserDefaults? = UserDefaults(suiteName: Self.appGroupIdentifier)) {
        self.defaults = defaults
    }

    @discardableResult
    public func save(
        scopeID: String,
        sources: [ProviderQuotaWidgetSource],
        updatedSourceIDs: Set<String>? = nil,
        serverID: String? = nil,
        profileID: String? = nil,
        sourceGeneration: String? = nil
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
                ProviderQuotaWidgetSnapshot(updatedAt: Date(), sources: persistedSources, serverID: serverID, profileID: profileID, sourceGeneration: sourceGeneration)
              )
        else {
            return false
        }
        defaults.set(data, forKey: Self.storageKey)
        return true
    }

    public func load() -> ProviderQuotaWidgetSnapshot? {
        guard let data = defaults?.data(forKey: Self.storageKey),
              let snapshot = try? JSONDecoder().decode(ProviderQuotaWidgetSnapshot.self, from: data)
        else { return nil }
        // A snapshot cached from an older server can repeat a source id; every reader
        // looks rows up by id, so keep the first row per id.
        var seen = Set<String>()
        return ProviderQuotaWidgetSnapshot(
            updatedAt: snapshot.updatedAt,
            sources: snapshot.sources.filter { seen.insert($0.sourceID).inserted },
            serverID: snapshot.serverID, profileID: snapshot.profileID, sourceGeneration: snapshot.sourceGeneration
        )
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
