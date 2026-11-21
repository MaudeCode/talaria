import Foundation
import Observation

public protocol InsightsDataClient: Sendable {
    func insights(days: Int, start: String?, end: String?) async throws -> InsightsResponse
}

extension APIClient: InsightsDataClient {}

public enum AnalyticsTimeframe: String, CaseIterable, Identifiable, Sendable {
    case today
    case last7Days
    case last30Days
    case allTime
    /// TAL-1117: the picked start and end days, resolved by the server.
    case custom

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
        case .custom:
            String(localized: "Custom")
        }
    }

    public var pickerTitle: String {
        switch self {
        case .today: String(localized: "Today")
        case .last7Days: String(localized: "7 Days")
        case .last30Days: String(localized: "30 Days")
        case .allTime: String(localized: "All Time")
        case .custom: String(localized: "Custom")
        }
    }

    /// The `days` preset sent with each request; a custom range falls back to the server's default window.
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
        case .custom:
            30
        }
    }
}

/// TAL-1117: a custom range's start and end days as picked (`YYYY-MM-DD`); the server validates and resolves them.
public struct InsightsCustomRange: Hashable, Sendable {
    public var start: String
    public var end: String

    public init(start: String, end: String) {
        self.start = start
        self.end = end
    }
}

/// One `/api/insights` read: its request and its cache identity.
public struct InsightsRequest: Hashable, Sendable {
    public let timeframe: AnalyticsTimeframe
    public let custom: InsightsCustomRange?

    public init(timeframe: AnalyticsTimeframe, custom: InsightsCustomRange? = nil) {
        self.timeframe = timeframe
        self.custom = timeframe == .custom ? custom : nil
    }

    /// Presets keep the keys cached before custom ranges existed; a custom range adds its days.
    var cacheKey: String {
        guard let custom else { return timeframe.rawValue }
        return "\(timeframe.rawValue)|\(custom.start)|\(custom.end)"
    }
}

@MainActor
@Observable
public final class InsightsViewModel {
    private(set) var serverInsights: InsightsResponse?
    public var selectedTimeframe: AnalyticsTimeframe = .last30Days
    /// The custom range being picked; kept across preset switches so Custom comes back with it.
    public var customRange: InsightsCustomRange?
    private(set) var loadedRequest = InsightsRequest(timeframe: .last30Days)
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
        if let response = cache?.load(request) {
            serverInsights = response
            loadedRequest = request
        }
    }

    /// The read the current selection asks for; a view reloads when it changes.
    public var request: InsightsRequest {
        InsightsRequest(timeframe: selectedTimeframe, custom: customRange)
    }

    /// Picks a period. A first Custom starts from the range on screen.
    public func select(_ timeframe: AnalyticsTimeframe) {
        if timeframe == .custom, customRange == nil,
           let range = serverInsights?.range, let start = range.startDate, let end = range.endDate {
            customRange = InsightsCustomRange(start: start, end: end)
        }
        selectedTimeframe = timeframe
    }

    public func load() async {
        let loadID = UUID()
        let request = request
        activeLoadID = loadID
        if let cached = cache?.load(request) {
            serverInsights = cached
            loadedRequest = request
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
                let response = try await client.insights(
                    days: request.timeframe.serverDays,
                    start: request.custom?.start,
                    end: request.custom?.end
                )
                guard activeLoadID == loadID, !Task.isCancelled else { return }

                serverInsights = response
                loadedRequest = request
                cache?.save(response, for: request)
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

    public var sourceDescription: String? {
        if let fallbackReason, serverInsights != nil {
            return String(localized: "Showing cached server analytics. Refresh failed: \(fallbackReason)")
        }
        if isLoading, serverInsights != nil {
            return String(localized: "Showing cached server analytics while refreshing.")
        }
        return nil
    }

    public var periodTitle: String {
        if let range, range.isCustom,
           let start = insightsCalendarDay(range.startDate), let end = insightsCalendarDay(range.endDate), start <= end {
            return (start..<end).formatted(.interval.year().month(.abbreviated).day())
        }
        // All Time and a custom request the server served as its preset both name the days served.
        if serverInsights != nil, loadedRequest.timeframe == .allTime || loadedRequest.timeframe == .custom {
            return String(localized: "Last \(periodDays) Days")
        }

        return loadedRequest.timeframe.title
    }

    /// The server's range for the loaded read; nil from a server that predates custom ranges.
    public var range: InsightsRange? {
        serverInsights?.range
    }

    /// The custom range's time zone, which its days and hours use.
    public var rangeTimezone: String? {
        range?.isCustom == true ? range?.timezone : nil
    }

    /// Why the served range differs from the requested one, as the server reported it.
    public var rangeNotes: [String] {
        guard let range else { return [] }
        var notes: [String] = []
        switch range.fallbackReason {
        case "invalid_start": notes.append(String(localized: "Unreadable start date; showing \(periodDays) days"))
        case "invalid_end": notes.append(String(localized: "Unreadable end date; showing \(periodDays) days"))
        case "future": notes.append(String(localized: "Start date is in the future; showing \(periodDays) days"))
        default: break
        }
        if range.isCapped {
            notes.append(String(localized: "Shortened to the last five years"))
        }
        return notes
    }

    var periodDays: Int {
        serverInsights?.periodDays ?? selectedTimeframe.serverDays
    }

    public var modelBreakdowns: [InsightsModelBreakdown] {
        serverInsights?.models ?? []
    }

    /// The server's whole daily series for the loaded period, oldest first.
    public var dailyTokens: [InsightsDailyToken] {
        serverInsights?.dailyTokens ?? []
    }

    public var activityByDay: [InsightsActivityByDay] {
        serverInsights?.activityByDay ?? []
    }

    public var activityByHour: [InsightsActivityByHour] {
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

    func load(_ request: InsightsRequest) -> InsightsResponse? {
        payload()[serverKey]?[request.cacheKey]
    }

    /// Keeps one custom range per server, beside each preset, so picking dates never grows the cache.
    func save(_ response: InsightsResponse, for request: InsightsRequest) {
        var payload = payload()
        var serverResponses = payload[serverKey] ?? [:]
        if request.custom != nil {
            serverResponses = serverResponses.filter { !$0.key.hasPrefix("\(AnalyticsTimeframe.custom.rawValue)|") }
        }
        serverResponses[request.cacheKey] = response
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
