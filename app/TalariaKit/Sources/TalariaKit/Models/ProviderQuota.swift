import Foundation

/// Sanitized, widget-ready quota sources returned by `GET /api/provider/quotas`.
/// Source IDs are opaque and already scoped by the server to its instance,
/// profile, provider, and credential account, so they can be persisted without
/// storing a server URL or credential-derived identity.
public struct ProviderQuotasResponse: Codable, Equatable, Sendable {
    public let version: Int?
    public let scopeID: String?
    public let profileID: String?
    let activeProvider: String?
    let requestedSourceID: String?
    public let missingSource: Bool
    public let sources: [ProviderQuotaSource]
    /// Server reference time of every window's `pace`; each source carries it too.
    public let computedAt: String?

    enum CodingKeys: String, CodingKey {
        case version
        case computedAt
        case scopeID = "scopeId"
        case profileID = "profileId"
        case activeProvider
        case requestedSourceID = "requestedSourceId"
        case missingSource
        case sources
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = container.decodeQuotaIntIfPresent(forKey: .version)
        scopeID = container.decodeQuotaStringIfPresent(forKey: .scopeID)
        profileID = container.decodeQuotaStringIfPresent(forKey: .profileID)
        activeProvider = container.decodeQuotaStringIfPresent(forKey: .activeProvider)
        requestedSourceID = container.decodeQuotaStringIfPresent(forKey: .requestedSourceID)
        missingSource = container.decodeQuotaBoolIfPresent(forKey: .missingSource) ?? false
        let computedAt = container.decodeQuotaStringIfPresent(forKey: .computedAt)
        self.computedAt = computedAt
        sources = ((try? container.decodeIfPresent([ProviderQuotaSource].self, forKey: .sources)) ?? [])
            .filter { !$0.id.isEmpty }
            .map { source in
                var source = source
                source.computedAt = source.computedAt ?? computedAt
                return source
            }
    }
}

public struct ProviderQuotaSource: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let providerID: String
    public let providerLabel: String
    let accountLabel: String
    public let isActiveProvider: Bool
    let supported: Bool
    public let status: String
    public let plan: String?
    public let windows: [ProviderQuotaWindow]
    public let quota: ProviderQuotaAmount?
    public let details: [String]
    public let unavailableReason: String?
    public let retryAfter: String?
    public let fetchedAt: String?
    public let message: String?
    /// Windows the server selected for pace, session, and weekly displays.
    public let paceWindowIndex: Int?
    public let sessionWindowIndex: Int?
    public let weeklyWindowIndex: Int?
    /// The response's `computed_at`, kept per source because targeted refreshes merge sources.
    public internal(set) var computedAt: String?

    enum CodingKeys: String, CodingKey {
        case id = "sourceId"
        case providerID = "providerId"
        case providerLabel
        case accountLabel
        case isActiveProvider
        case supported
        case status
        case plan
        case windows
        case quota
        case details
        case unavailableReason
        case retryAfter
        case fetchedAt
        case message
        case paceWindowIndex
        case sessionWindowIndex
        case weeklyWindowIndex
        case computedAt
    }

    public init(
        id: String,
        providerID: String,
        providerLabel: String,
        accountLabel: String,
        isActiveProvider: Bool = false,
        supported: Bool,
        status: String,
        plan: String? = nil,
        windows: [ProviderQuotaWindow] = [],
        quota: ProviderQuotaAmount? = nil,
        details: [String] = [],
        unavailableReason: String? = nil,
        retryAfter: String? = nil,
        fetchedAt: String? = nil,
        message: String? = nil,
        paceWindowIndex: Int? = nil,
        sessionWindowIndex: Int? = nil,
        weeklyWindowIndex: Int? = nil,
        computedAt: String? = nil
    ) {
        self.id = id
        self.providerID = providerID
        self.providerLabel = providerLabel
        self.accountLabel = accountLabel
        self.isActiveProvider = isActiveProvider
        self.supported = supported
        self.status = status
        self.plan = plan
        self.windows = windows
        self.quota = quota
        self.details = details
        self.unavailableReason = unavailableReason
        self.retryAfter = retryAfter
        self.fetchedAt = fetchedAt
        self.message = message
        self.paceWindowIndex = paceWindowIndex
        self.sessionWindowIndex = sessionWindowIndex
        self.weeklyWindowIndex = weeklyWindowIndex
        self.computedAt = computedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.decodeQuotaStringIfPresent(forKey: .id) ?? ""
        providerID = container.decodeQuotaStringIfPresent(forKey: .providerID) ?? ""
        providerLabel = container.decodeQuotaStringIfPresent(forKey: .providerLabel) ?? providerID
        accountLabel = container.decodeQuotaStringIfPresent(forKey: .accountLabel) ?? providerLabel
        isActiveProvider = container.decodeQuotaBoolIfPresent(forKey: .isActiveProvider) ?? false
        supported = container.decodeQuotaBoolIfPresent(forKey: .supported) ?? false
        status = container.decodeQuotaStringIfPresent(forKey: .status) ?? "unavailable"
        plan = container.decodeQuotaStringIfPresent(forKey: .plan)
        windows = (try? container.decodeIfPresent([ProviderQuotaWindow].self, forKey: .windows)) ?? []
        quota = try? container.decodeIfPresent(ProviderQuotaAmount.self, forKey: .quota)
        details = (try? container.decodeIfPresent([String].self, forKey: .details)) ?? []
        unavailableReason = container.decodeQuotaStringIfPresent(forKey: .unavailableReason)
        retryAfter = container.decodeQuotaStringIfPresent(forKey: .retryAfter)
        fetchedAt = container.decodeQuotaStringIfPresent(forKey: .fetchedAt)
        message = container.decodeQuotaStringIfPresent(forKey: .message)
        paceWindowIndex = container.decodeQuotaIntIfPresent(forKey: .paceWindowIndex)
        sessionWindowIndex = container.decodeQuotaIntIfPresent(forKey: .sessionWindowIndex)
        weeklyWindowIndex = container.decodeQuotaIntIfPresent(forKey: .weeklyWindowIndex)
        computedAt = container.decodeQuotaStringIfPresent(forKey: .computedAt)
    }
}

public struct ProviderQuotaWindow: Codable, Equatable, Sendable {
    public let label: String
    public let windowSeconds: Int?
    public let usedPercent: Double?
    public let remainingPercent: Double?
    public let resetAt: String?
    public let detail: String?
    public let pace: ProviderQuotaWindowPace?
    public let forecast: ProviderQuotaWindowForecast?

    enum CodingKeys: String, CodingKey {
        case label
        case windowSeconds
        case usedPercent
        case remainingPercent
        case resetAt
        case detail
        case pace
        case forecast
    }

    public init(
        label: String,
        windowSeconds: Int? = nil,
        usedPercent: Double? = nil,
        remainingPercent: Double? = nil,
        resetAt: String? = nil,
        detail: String? = nil,
        pace: ProviderQuotaWindowPace? = nil,
        forecast: ProviderQuotaWindowForecast? = nil
    ) {
        self.label = label
        self.windowSeconds = windowSeconds
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetAt = resetAt
        self.detail = detail
        self.pace = pace
        self.forecast = forecast
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = container.decodeQuotaStringIfPresent(forKey: .label) ?? String(localized: "Quota")
        windowSeconds = container.decodeQuotaIntIfPresent(forKey: .windowSeconds)
        usedPercent = container.decodeQuotaDoubleIfPresent(forKey: .usedPercent)
        remainingPercent = container.decodeQuotaDoubleIfPresent(forKey: .remainingPercent)
        resetAt = container.decodeQuotaStringIfPresent(forKey: .resetAt)
        detail = container.decodeQuotaStringIfPresent(forKey: .detail)
        pace = try? container.decodeIfPresent(ProviderQuotaWindowPace.self, forKey: .pace)
        forecast = try? container.decodeIfPresent(ProviderQuotaWindowForecast.self, forKey: .forecast)
    }
}

/// Server-computed pace of one window, as of the source's `computedAt`.
public struct ProviderQuotaWindowPace: Codable, Equatable, Sendable {
    public let expectedRemainingPercent: Double
    public let paceDeltaPercent: Double
    public let burnRate: Double
    public let minutesToReset: Double
    public let projectedMinutesToEmpty: Double?
    public let elapsedMinutes: Double
    /// The window's reset; a cached pace past it describes the previous window.
    public let validUntil: String?

    public init(
        expectedRemainingPercent: Double,
        paceDeltaPercent: Double,
        burnRate: Double,
        minutesToReset: Double,
        projectedMinutesToEmpty: Double? = nil,
        elapsedMinutes: Double,
        validUntil: String? = nil
    ) {
        self.expectedRemainingPercent = expectedRemainingPercent
        self.paceDeltaPercent = paceDeltaPercent
        self.burnRate = burnRate
        self.minutesToReset = minutesToReset
        self.projectedMinutesToEmpty = projectedMinutesToEmpty
        self.elapsedMinutes = elapsedMinutes
        self.validUntil = validUntil
    }

    public func isValid(at date: Date) -> Bool {
        guard let validUntil = ProviderQuotaDateParser.date(from: validUntil) else { return false }
        return date < validUntil
    }
}

/// Server-computed forecast of one window: the budget until reset and whether it lasts.
public struct ProviderQuotaWindowForecast: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable {
        case safe
        case warning
    }

    public enum BudgetUnit: String, Codable, Sendable {
        case hour
        case day
    }

    public let outcome: Outcome
    public let budgetUnit: BudgetUnit
    public let budgetPercent: Double?
    /// Projected empty minus reset; negative empties early, nil when no depletion is projected.
    public let depletionMarginMinutes: Double?

    public init(outcome: Outcome, budgetUnit: BudgetUnit, budgetPercent: Double? = nil, depletionMarginMinutes: Double? = nil) {
        self.outcome = outcome
        self.budgetUnit = budgetUnit
        self.budgetPercent = budgetPercent
        self.depletionMarginMinutes = depletionMarginMinutes
    }
}

public struct ProviderQuotaAmount: Codable, Equatable, Sendable {
    public let limitRemaining: Double?
    public let usage: Double?
    public let limit: Double?

    enum CodingKeys: String, CodingKey {
        case limitRemaining
        case usage
        case limit
    }

    init(limitRemaining: Double? = nil, usage: Double? = nil, limit: Double? = nil) {
        self.limitRemaining = limitRemaining
        self.usage = usage
        self.limit = limit
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        limitRemaining = container.decodeQuotaDoubleIfPresent(forKey: .limitRemaining)
        usage = container.decodeQuotaDoubleIfPresent(forKey: .usage)
        limit = container.decodeQuotaDoubleIfPresent(forKey: .limit)
    }
}

// Kept local so this model can move into a WidgetKit target without pulling in
// the app-only decoding helpers currently declared alongside ChatMessage.
private extension KeyedDecodingContainer {
    func decodeQuotaStringIfPresent(forKey key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return "\(value)" }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return "\(value)" }
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value ? "true" : "false" }
        return nil
    }

    func decodeQuotaDoubleIfPresent(forKey key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value }
        guard let value = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return Double(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func decodeQuotaIntIfPresent(forKey key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite {
            return Int(exactly: value.rounded(.towardZero))
        }
        guard let value = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let value = Int(trimmed) { return value }
        guard let value = Double(trimmed), value.isFinite else { return nil }
        return Int(exactly: value.rounded(.towardZero))
    }

    func decodeQuotaBoolIfPresent(forKey key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            switch value {
            case 0: return false
            case 1: return true
            default: return nil
            }
        }
        guard let value = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "true", "1", "yes": return true
        case "false", "0", "no": return false
        default: return nil
        }
    }
}

public enum ProviderQuotaDateParser {
    public static func date(from value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return ISO8601DateFormatter().date(from: value) ?? fractional.date(from: value)
    }
}
