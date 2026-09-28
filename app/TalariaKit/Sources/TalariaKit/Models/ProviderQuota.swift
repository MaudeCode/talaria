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

    enum CodingKeys: String, CodingKey {
        case version
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
        sources = ((try? container.decodeIfPresent([ProviderQuotaSource].self, forKey: .sources)) ?? [])
            .filter { !$0.id.isEmpty }
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
        message: String? = nil
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
    }

    public func removed() -> ProviderQuotaSource {
        ProviderQuotaSource(
            id: id,
            providerID: providerID,
            providerLabel: providerLabel,
            accountLabel: accountLabel,
            isActiveProvider: false,
            supported: supported,
            status: "removed",
            unavailableReason: String(localized: "This quota account was removed. Refresh or reconfigure it."),
            fetchedAt: fetchedAt
        )
    }
}

public struct ProviderQuotaWindow: Codable, Equatable, Sendable {
    public let label: String
    public let windowSeconds: Int?
    public let usedPercent: Double?
    public let remainingPercent: Double?
    public let resetAt: String?
    public let detail: String?

    enum CodingKeys: String, CodingKey {
        case label
        case windowSeconds
        case usedPercent
        case remainingPercent
        case resetAt
        case detail
    }

    public init(
        label: String,
        windowSeconds: Int? = nil,
        usedPercent: Double? = nil,
        remainingPercent: Double? = nil,
        resetAt: String? = nil,
        detail: String? = nil
    ) {
        self.label = label
        self.windowSeconds = windowSeconds
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetAt = resetAt
        self.detail = detail
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = container.decodeQuotaStringIfPresent(forKey: .label) ?? String(localized: "Quota")
        windowSeconds = container.decodeQuotaIntIfPresent(forKey: .windowSeconds)
        usedPercent = container.decodeQuotaDoubleIfPresent(forKey: .usedPercent)
        remainingPercent = container.decodeQuotaDoubleIfPresent(forKey: .remainingPercent)
        resetAt = container.decodeQuotaStringIfPresent(forKey: .resetAt)
        detail = container.decodeQuotaStringIfPresent(forKey: .detail)
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

/// Compatibility shape for older servers that only expose the active provider.
public struct LegacyProviderQuotaResponse: Decodable, Equatable, Sendable {
    public let provider: String?
    public let displayName: String?
    public let supported: Bool?
    public let status: String?
    public let quota: ProviderQuotaAmount?
    public let accountLimits: LegacyProviderQuotaLimits?
    public let message: String?
}

public struct LegacyProviderQuotaLimits: Decodable, Equatable, Sendable {
    public let plan: String?
    public let windows: [ProviderQuotaWindow]?
    public let details: [String]?
    let available: Bool?
    public let unavailableReason: String?
    public let fetchedAt: String?
    public let pool: LegacyProviderQuotaPool?
}

public struct LegacyProviderQuotaPool: Decodable, Equatable, Sendable {
    public let credentials: [LegacyProviderQuotaCredential]?
}

public struct LegacyProviderQuotaCredential: Decodable, Equatable, Sendable {
    public let label: String?
    public let status: String?
    public let plan: String?
    public let windows: [ProviderQuotaWindow]?
    public let details: [String]?
    public let unavailableReason: String?
    public let retryAfter: String?
    public let fetchedAt: String?
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
