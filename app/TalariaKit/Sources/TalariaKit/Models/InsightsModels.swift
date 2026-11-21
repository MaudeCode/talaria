import Foundation

public struct InsightsResponse: Codable, Equatable, Sendable {
    public let periodDays: Int?
    /// The interval the server served (TAL-1117); nil from a server that predates custom ranges.
    public let range: InsightsRange?
    public let totalSessions: Int?
    public let totalMessages: Int?
    public let totalInputTokens: Int?
    public let totalOutputTokens: Int?
    public let totalTokens: Int?
    public let totalCost: Double?
    public let totalCacheReadTokens: Int?
    public let totalCacheHitPercent: Double?
    public let models: [InsightsModelBreakdown]?
    public let dailyTokens: [InsightsDailyToken]?
    public let activityByDay: [InsightsActivityByDay]?
    public let activityByHour: [InsightsActivityByHour]?

    enum CodingKeys: String, CodingKey {
        case periodDays
        case range
        case totalSessions
        case totalMessages
        case totalInputTokens
        case totalOutputTokens
        case totalTokens
        case totalCost
        case totalCacheReadTokens
        case totalCacheHitPercent
        case models
        case dailyTokens
        case activityByDay
        case activityByHour
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        periodDays = container.decodeLossyIntIfPresent(forKey: .periodDays)
        range = (try? container.decodeIfPresent(InsightsRange.self, forKey: .range)) ?? nil
        totalSessions = container.decodeLossyIntIfPresent(forKey: .totalSessions)
        totalMessages = container.decodeLossyIntIfPresent(forKey: .totalMessages)
        totalInputTokens = container.decodeLossyIntIfPresent(forKey: .totalInputTokens)
        totalOutputTokens = container.decodeLossyIntIfPresent(forKey: .totalOutputTokens)
        totalTokens = container.decodeLossyIntIfPresent(forKey: .totalTokens)
        totalCost = container.decodeLossyCurrencyDoubleIfPresent(forKey: .totalCost)
        totalCacheReadTokens = container.decodeLossyIntIfPresent(forKey: .totalCacheReadTokens)
        totalCacheHitPercent = container.decodeLossyCurrencyDoubleIfPresent(forKey: .totalCacheHitPercent)
        models = (try? container.decodeIfPresent([InsightsModelBreakdown].self, forKey: .models)) ?? nil
        dailyTokens = (try? container.decodeIfPresent([InsightsDailyToken].self, forKey: .dailyTokens)) ?? nil
        activityByDay = (try? container.decodeIfPresent([InsightsActivityByDay].self, forKey: .activityByDay)) ?? nil
        activityByHour = (try? container.decodeIfPresent([InsightsActivityByHour].self, forKey: .activityByHour)) ?? nil
    }
}

public struct InsightsModelBreakdown: Codable, Equatable, Sendable {
    public let model: String?
    public let sessions: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let totalTokens: Int?
    public let cost: Double?
    public let cacheHitPercent: Double?
    let sessionShare: Int?
    let tokenShare: Int?
    let costShare: Int?
    /// The server's choice of share to show (TAL-1750); nil from a server that predates it.
    let serverDisplayShare: Int?

    enum CodingKeys: String, CodingKey {
        case model
        case sessions
        case inputTokens
        case outputTokens
        case totalTokens
        case cost
        case cacheHitPercent
        case sessionShare
        case tokenShare
        case costShare
        case serverDisplayShare = "displayShare"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        model = container.decodeLossyStringIfPresent(forKey: .model)
        sessions = container.decodeLossyIntIfPresent(forKey: .sessions)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        totalTokens = container.decodeLossyIntIfPresent(forKey: .totalTokens)
        cost = container.decodeLossyCurrencyDoubleIfPresent(forKey: .cost)
        cacheHitPercent = container.decodeLossyCurrencyDoubleIfPresent(forKey: .cacheHitPercent)
        sessionShare = container.decodeLossyIntIfPresent(forKey: .sessionShare)
        tokenShare = container.decodeLossyIntIfPresent(forKey: .tokenShare)
        costShare = container.decodeLossyIntIfPresent(forKey: .costShare)
        serverDisplayShare = container.decodeLossyIntIfPresent(forKey: .serverDisplayShare)
    }

    /// The server's `display_share`; an older server leaves the client to pick cost, then tokens, then sessions.
    public var displayShare: Int? {
        if let serverDisplayShare { return serverDisplayShare }
        let shares = [costShare, tokenShare, sessionShare].compactMap { $0 }
        return shares.first { $0 > 0 } ?? shares.first
    }
}

public struct InsightsDailyToken: Codable, Equatable, Sendable {
    public let date: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    /// The server's day total (TAL-1750); a server that predates it leaves it nil and `totalTokens` sums the split.
    public let serverTotalTokens: Int?
    /// Prompt tokens served from the cache; already counted inside `inputTokens`.
    public let cacheReadTokens: Int?
    public let sessions: Int?
    public let cost: Double?

    enum CodingKeys: String, CodingKey {
        case date
        case inputTokens
        case outputTokens
        case serverTotalTokens = "totalTokens"
        case cacheReadTokens
        case sessions
        case cost
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = container.decodeLossyStringIfPresent(forKey: .date)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        serverTotalTokens = container.decodeLossyIntIfPresent(forKey: .serverTotalTokens)
        cacheReadTokens = container.decodeLossyIntIfPresent(forKey: .cacheReadTokens)
        sessions = container.decodeLossyIntIfPresent(forKey: .sessions)
        cost = container.decodeLossyCurrencyDoubleIfPresent(forKey: .cost)
    }

    public var totalTokens: Int {
        serverTotalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
    }

    /// The server's `YYYY-MM-DD` bucket as a local calendar day, for charting; nil for any other text.
    public var day: Date? {
        insightsCalendarDay(date)
    }
}

/// A server `YYYY-MM-DD` day as that day's local midnight, for display and date pickers; nil for any other text.
public func insightsCalendarDay(_ text: String?) -> Date? {
    guard let text, text.count == 10 else { return nil }
    let parts = text.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return wireCalendar().date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
}

/// A picked local day as the `YYYY-MM-DD` text the server reads on its own calendar.
public func insightsDayText(_ date: Date) -> String {
    let day = wireCalendar().dateComponents([.year, .month, .day], from: date)
    return String(format: "%04ld-%02ld-%02ld", day.year ?? 0, day.month ?? 0, day.day ?? 0)
}

/// Server days are Gregorian whatever calendar the iPhone uses; the local zone keeps them on the picker's midnights.
private func wireCalendar() -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    return calendar
}

/// TAL-1117: the interval an Insights read covers, resolved on the server calendar. Clients render it as sent.
public struct InsightsRange: Codable, Equatable, Sendable {
    /// `custom` when the requested start/end were served; `preset` for the trailing `days` window, fallbacks included.
    public let mode: String?
    public let startDate: String?
    public let endDate: String?
    /// The server's current day, the latest a date control offers.
    public let today: String?
    public let timezone: String?
    /// `month` once the range passes 366 days: each `daily_tokens` row then totals a month.
    public let bucket: String?
    /// Why a requested custom range was not served: `invalid_start`, `invalid_end` or `future`.
    public let fallbackReason: String?
    /// `reversed` and/or `capped` when the served custom range differs from the request.
    public let adjustments: [String]

    enum CodingKeys: String, CodingKey {
        case mode
        case startDate
        case endDate
        case today
        case timezone
        case bucket
        case fallbackReason
        case adjustments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = container.decodeLossyStringIfPresent(forKey: .mode)
        startDate = container.decodeLossyStringIfPresent(forKey: .startDate)
        endDate = container.decodeLossyStringIfPresent(forKey: .endDate)
        today = container.decodeLossyStringIfPresent(forKey: .today)
        timezone = container.decodeLossyStringIfPresent(forKey: .timezone)
        bucket = container.decodeLossyStringIfPresent(forKey: .bucket)
        fallbackReason = container.decodeLossyStringIfPresent(forKey: .fallbackReason)
        adjustments = ((try? container.decodeIfPresent([String].self, forKey: .adjustments)) ?? nil) ?? []
    }

    public var isCustom: Bool { mode == "custom" }
    public var isMonthly: Bool { bucket == "month" }
    public var isCapped: Bool { adjustments.contains("capped") }
}

public struct InsightsActivityByDay: Codable, Equatable, Sendable {
    public let day: String?
    public let sessions: Int?

    enum CodingKeys: String, CodingKey {
        case day
        case sessions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        day = container.decodeLossyStringIfPresent(forKey: .day)
        sessions = container.decodeLossyIntIfPresent(forKey: .sessions)
    }
}

public struct InsightsActivityByHour: Codable, Equatable, Sendable {
    public let hour: Int?
    public let sessions: Int?

    enum CodingKeys: String, CodingKey {
        case hour
        case sessions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hour = container.decodeLossyIntIfPresent(forKey: .hour)
        sessions = container.decodeLossyIntIfPresent(forKey: .sessions)
    }
}

private extension KeyedDecodingContainer {
    func decodeLossyCurrencyDoubleIfPresent(forKey key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            return value
        }

        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            return Double(value)
        }

        guard let stringValue = try? decodeIfPresent(String.self, forKey: key) else {
            return nil
        }

        let normalized = stringValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")

        guard !normalized.isEmpty else { return nil }
        return Double(normalized)
    }
}
