import Foundation
import Observation

public protocol InsightsDataClient {
    func insights(days: Int) async throws -> InsightsResponse
}

extension APIClient: InsightsDataClient {}

public enum AnalyticsTimeframe: String, CaseIterable, Identifiable {
    case today
    case last7Days
    case last30Days
    case allTime

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .today:
            String(localized: "Today")
        case .last7Days:
            String(localized: "Last 7 Days")
        case .last30Days:
            String(localized: "Last 30 Days")
        case .allTime:
            String(localized: "All Time")
        }
    }

    public var pickerTitle: String {
        switch self {
        case .today: String(localized: "Today")
        case .last7Days: String(localized: "7 Days")
        case .last30Days: String(localized: "30 Days")
        case .allTime: String(localized: "All Time")
        }
    }

    var serverDays: Int {
        switch self {
        case .today:
            1
        case .last7Days:
            7
        case .last30Days:
            30
        case .allTime:
            365
        }
    }
}

@MainActor
@Observable
public final class InsightsViewModel {
    private(set) var serverInsights: InsightsResponse?
    public var selectedTimeframe: AnalyticsTimeframe = .last30Days
    private(set) var loadedTimeframe: AnalyticsTimeframe = .last30Days
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var lastError: Error?
    private(set) var fallbackReason: String?
    private var activeLoadID: UUID?

    private let client: any InsightsDataClient
    private let cache: InsightsResponseCache?
    private let sleep: @MainActor (Duration) async throws -> Void

    public convenience init(server: URL) {
        self.init(client: APIClient(baseURL: server), cache: InsightsResponseCache(server: server))
    }

    /// `sleep` waits between transient-failure retries; tests inject one that never touches the wall clock.
    init(
        client: any InsightsDataClient,
        cache: InsightsResponseCache? = nil,
        sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.cache = cache
        self.sleep = sleep
        if let response = cache?.load(timeframe: selectedTimeframe) {
            serverInsights = response
            loadedTimeframe = selectedTimeframe
        }
    }

    public func load() async {
        let loadID = UUID()
        let timeframe = selectedTimeframe
        activeLoadID = loadID
        if let cached = cache?.load(timeframe: timeframe) {
            serverInsights = cached
            loadedTimeframe = timeframe
        }
        isLoading = true
        errorMessage = nil
        lastError = nil
        fallbackReason = nil
        let hadLoadedAnalytics = hasLoadedAnalytics
        defer {
            if activeLoadID == loadID {
                isLoading = false
            }
        }

        var retryDelays = Self.retryDelays[...]
        while true {
            do {
                let response = try await client.insights(days: timeframe.serverDays)
                guard activeLoadID == loadID, !Task.isCancelled else { return }

                serverInsights = response
                loadedTimeframe = timeframe
                cache?.save(response, timeframe: timeframe)
                return
            } catch is CancellationError {
                return
            } catch {
                guard activeLoadID == loadID, !Task.isCancelled else { return }

                if CacheFallbackPolicy.shouldUseCache(for: error), let delay = retryDelays.popFirst() {
                    do {
                        try await sleep(delay)
                    } catch {
                        return
                    }
                    guard activeLoadID == loadID, !Task.isCancelled else { return }
                    continue
                }

                lastError = error
                fallbackReason = error.localizedDescription
                if !hadLoadedAnalytics {
                    errorMessage = error.localizedDescription
                }
                return
            }
        }
    }

    /// Waits between the four `/api/insights` attempts a transient failure earns.
    private static let retryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]

    // MARK: - Aggregates

    public var totalInputTokens: Int {
        serverInsights?.totalInputTokens ?? 0
    }

    public var totalOutputTokens: Int {
        serverInsights?.totalOutputTokens ?? 0
    }

    public var totalTokens: Int {
        serverInsights?.totalTokens ?? 0
    }

    public var totalMessages: Int {
        serverInsights?.totalMessages ?? 0
    }

    public var estimatedCost: Double {
        serverInsights?.totalCost ?? 0
    }

    /// Older servers may omit cache statistics; nil hides the corresponding cards.
    public var totalCacheReadTokens: Int? {
        serverInsights?.totalCacheReadTokens
    }

    public var totalCacheHitPercent: Double? {
        serverInsights?.totalCacheHitPercent
    }

    public var sessionCount: Int {
        serverInsights?.totalSessions ?? 0
    }

    public var hasLoadedAnalytics: Bool {
        serverInsights != nil
    }

    public var sourceDescription: String {
        if let fallbackReason, serverInsights != nil {
            return String(localized: "Showing cached server analytics. Refresh failed: \(fallbackReason)")
        }
        if isLoading, serverInsights != nil {
            return String(localized: "Showing cached server analytics while refreshing.")
        }
        return String(localized: "Source: server insights from the last \(periodDays) days.")
    }

    public var periodTitle: String {
        if serverInsights != nil, loadedTimeframe == .allTime {
            return String(localized: "Last \(periodDays) Days")
        }

        return loadedTimeframe.title
    }

    var periodDays: Int {
        serverInsights?.periodDays ?? selectedTimeframe.serverDays
    }

    public var modelBreakdowns: [InsightsModelBreakdown] {
        serverInsights?.models ?? []
    }

    public var recentDailyTokens: [InsightsDailyToken] {
        Array((serverInsights?.dailyTokens ?? []).suffix(14))
    }

    var activityByDay: [InsightsActivityByDay] {
        serverInsights?.activityByDay ?? []
    }

    var activityByHour: [InsightsActivityByHour] {
        serverInsights?.activityByHour ?? []
    }

    public var peakDay: InsightsActivityByDay? {
        activityByDay.max { ($0.sessions ?? 0) < ($1.sessions ?? 0) }
    }

    public var peakHour: InsightsActivityByHour? {
        activityByHour.max { ($0.sessions ?? 0) < ($1.sessions ?? 0) }
    }
}

public struct InsightsResponseCache {
    public static let storageKey = "insights.responseCache.v1"

    private let serverKey: String
    private let defaults: UserDefaults

    init(server: URL, defaults: UserDefaults = .standard) {
        serverKey = server.absoluteString
        self.defaults = defaults
    }

    func load(timeframe: AnalyticsTimeframe) -> InsightsResponse? {
        payload()[serverKey]?[timeframe.rawValue]
    }

    func save(_ response: InsightsResponse, timeframe: AnalyticsTimeframe) {
        var payload = payload()
        var serverResponses = payload[serverKey] ?? [:]
        serverResponses[timeframe.rawValue] = response
        payload[serverKey] = serverResponses
        defaults.set(try? JSONEncoder().encode(payload), forKey: Self.storageKey)
    }

    /// Drops this server's cached responses when the server is removed from
    /// the app, leaving every other server's entries in place.
    func clear() {
        var payload = payload()
        guard payload.removeValue(forKey: serverKey) != nil else { return }
        defaults.set(try? JSONEncoder().encode(payload), forKey: Self.storageKey)
    }

    private func payload() -> [String: [String: InsightsResponse]] {
        guard let data = defaults.data(forKey: Self.storageKey) else { return [:] }
        return (try? JSONDecoder().decode([String: [String: InsightsResponse]].self, from: data)) ?? [:]
    }
}
