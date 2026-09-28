import Foundation

public struct InsightsResponse: Codable, Equatable {
    public let periodDays: Int?
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

public struct InsightsModelBreakdown: Codable, Equatable {
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
    }

    public var displayShare: Int? {
        let shares = [costShare, tokenShare, sessionShare].compactMap { $0 }
        return shares.first { $0 > 0 } ?? shares.first
    }
}

public struct InsightsDailyToken: Codable, Equatable {
    public let date: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let sessions: Int?
    public let cost: Double?

    enum CodingKeys: String, CodingKey {
        case date
        case inputTokens
        case outputTokens
        case sessions
        case cost
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = container.decodeLossyStringIfPresent(forKey: .date)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        sessions = container.decodeLossyIntIfPresent(forKey: .sessions)
        cost = container.decodeLossyCurrencyDoubleIfPresent(forKey: .cost)
    }
}

public struct InsightsActivityByDay: Codable, Equatable {
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

public struct InsightsActivityByHour: Codable, Equatable {
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
