import Foundation
import Observation
import TalariaKit

protocol InsightsDataClient {
    func sessions() async throws -> SessionsResponse
    func insights(days: Int) async throws -> InsightsResponse
}

extension APIClient: InsightsDataClient {}

enum AnalyticsTimeframe: String, CaseIterable, Identifiable {
    case today
    case last7Days
    case last30Days
    case allTime

    var id: String { rawValue }

    var title: String {
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

    var pickerTitle: String {
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

    func contains(_ session: SessionSummary, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard self != .allTime else { return true }

        guard let timestamp = session.analyticsTimestamp else {
            return false
        }

        let sessionDate = Date(timeIntervalSince1970: timestamp)

        switch self {
        case .today:
            return calendar.isDate(sessionDate, inSameDayAs: now)
        case .last7Days:
            return sessionDate >= calendar.date(byAdding: .day, value: -7, to: now) ?? now
                && sessionDate <= now
        case .last30Days:
            return sessionDate >= calendar.date(byAdding: .day, value: -30, to: now) ?? now
                && sessionDate <= now
        case .allTime:
            return true
        }
    }
}

struct SessionUsageAnalytics {
    let sessions: [SessionSummary]

    var totalInputTokens: Int {
        sessions.compactMap { $0.inputTokens }.reduce(0, +)
    }

    var totalOutputTokens: Int {
        sessions.compactMap { $0.outputTokens }.reduce(0, +)
    }

    var totalTokens: Int {
        totalInputTokens + totalOutputTokens
    }

    var totalMessages: Int {
        sessions.compactMap { $0.messageCount }.reduce(0, +)
    }

    var estimatedCost: Double {
        sessions.compactMap { $0.estimatedCost }.reduce(0, +)
    }

    var sessionCount: Int {
        sessions.count
    }

    var topSessions: [SessionSummary] {
        sessions.sorted {
            let leftTotal = ($0.inputTokens ?? 0) + ($0.outputTokens ?? 0)
            let rightTotal = ($1.inputTokens ?? 0) + ($1.outputTokens ?? 0)
            return leftTotal > rightTotal
        }
    }
}

enum InsightsDataSource: Equatable {
    case server
    case localFallback
    case local
}

@MainActor
@Observable
final class InsightsViewModel {
    private(set) var sessions: [SessionSummary] = []
    private(set) var serverInsights: InsightsResponse?
    var selectedTimeframe: AnalyticsTimeframe = .last30Days
    private(set) var loadedTimeframe: AnalyticsTimeframe = .last30Days
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var lastError: Error?
    private(set) var dataSource: InsightsDataSource = .local
    private(set) var fallbackReason: String?
    private var activeLoadID: UUID?

    private let client: any InsightsDataClient
    private let cache: InsightsResponseCache?

    init(server: URL) {
        client = APIClient(baseURL: server)
        let cache = InsightsResponseCache(server: server)
        self.cache = cache
        if let response = cache.load(timeframe: selectedTimeframe) {
            serverInsights = response
            loadedTimeframe = selectedTimeframe
            dataSource = .server
        }
    }

    init(client: any InsightsDataClient) {
        self.client = client
        cache = nil
    }

    func load() async {
        let loadID = UUID()
        let timeframe = selectedTimeframe
        activeLoadID = loadID
        if let cached = cache?.load(timeframe: timeframe) {
            serverInsights = cached
            sessions = []
            loadedTimeframe = timeframe
            dataSource = .server
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

        do {
            let response = try await client.insights(days: timeframe.serverDays)
            guard activeLoadID == loadID, !Task.isCancelled else { return }

            serverInsights = response
            sessions = []
            loadedTimeframe = timeframe
            dataSource = .server
            cache?.save(response, timeframe: timeframe)
        } catch is CancellationError {
            return
        } catch {
            guard activeLoadID == loadID, !Task.isCancelled else { return }
            lastError = error
            fallbackReason = error.localizedDescription

            do {
                let response = try await client.sessions()
                guard activeLoadID == loadID, !Task.isCancelled else { return }

                serverInsights = nil
                sessions = response.sessions ?? []
                loadedTimeframe = timeframe
                dataSource = .localFallback
            } catch is CancellationError {
                return
            } catch {
                guard activeLoadID == loadID, !Task.isCancelled else { return }
                lastError = error
                if hadLoadedAnalytics {
                    fallbackReason = error.localizedDescription
                } else {
                    errorMessage = error.localizedDescription
                    dataSource = .local
                }
            }
        }
    }

    // MARK: - Aggregates

    var analytics: SessionUsageAnalytics {
        SessionUsageAnalytics(sessions: filteredSessions)
    }

    var filteredSessions: [SessionSummary] {
        sessions.filter { loadedTimeframe.contains($0) }
    }

    var totalInputTokens: Int {
        serverInsights?.totalInputTokens ?? analytics.totalInputTokens
    }

    var totalOutputTokens: Int {
        serverInsights?.totalOutputTokens ?? analytics.totalOutputTokens
    }

    var totalTokens: Int {
        serverInsights?.totalTokens ?? analytics.totalTokens
    }

    var totalMessages: Int {
        serverInsights?.totalMessages ?? analytics.totalMessages
    }

    var estimatedCost: Double {
        serverInsights?.totalCost ?? analytics.estimatedCost
    }

    /// Cache stats only exist in server insights — nil hides the cards on
    /// the local fallback and on older servers that don't report them (#24).
    var totalCacheReadTokens: Int? {
        serverInsights?.totalCacheReadTokens
    }

    var totalCacheHitPercent: Double? {
        serverInsights?.totalCacheHitPercent
    }

    var sessionCount: Int {
        serverInsights?.totalSessions ?? analytics.sessionCount
    }

    var hasLoadedAnalytics: Bool {
        serverInsights != nil || dataSource == .localFallback
    }

    var sourceDescription: String {
        switch dataSource {
        case .server:
            return String(localized: "Source: server insights from the last \(periodDays) days.")
        case .localFallback:
            if let fallbackReason, !fallbackReason.isEmpty {
                return String(localized: "Source: local session metadata fallback. Server insights failed: \(fallbackReason)")
            }
            return String(localized: "Source: local session metadata fallback.")
        case .local:
            return String(localized: "Source: local session metadata.")
        }
    }

    var periodTitle: String {
        if dataSource == .server, loadedTimeframe == .allTime {
            return String(localized: "Last \(periodDays) Days")
        }

        return loadedTimeframe.title
    }

    var periodDays: Int {
        serverInsights?.periodDays ?? selectedTimeframe.serverDays
    }

    var modelBreakdowns: [InsightsModelBreakdown] {
        serverInsights?.models ?? []
    }

    var recentDailyTokens: [InsightsDailyToken] {
        Array((serverInsights?.dailyTokens ?? []).suffix(14))
    }

    var activityByDay: [InsightsActivityByDay] {
        serverInsights?.activityByDay ?? []
    }

    var activityByHour: [InsightsActivityByHour] {
        serverInsights?.activityByHour ?? []
    }

    var peakDay: InsightsActivityByDay? {
        activityByDay.max { ($0.sessions ?? 0) < ($1.sessions ?? 0) }
    }

    var peakHour: InsightsActivityByHour? {
        activityByHour.max { ($0.sessions ?? 0) < ($1.sessions ?? 0) }
    }

    // MARK: - Top sessions

    /// All sessions sorted by total tokens (descending), with cost shown when available.
    /// Falls back to input-only or output-only if one is missing.
    var topSessions: [SessionSummary] {
        guard dataSource != .server else { return [] }
        return analytics.topSessions
    }
}

struct InsightsResponseCache {
    static let storageKey = "insights.responseCache.v1"

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

private extension SessionSummary {
    var analyticsTimestamp: Double? {
        lastMessageAt ?? updatedAt ?? createdAt
    }
}
