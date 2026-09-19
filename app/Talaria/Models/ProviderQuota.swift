import Foundation

/// Sanitized, widget-ready quota sources returned by `GET /api/provider/quotas`.
/// Source IDs are opaque and already scoped by the server to its instance,
/// profile, provider, and credential account, so they can be persisted without
/// storing a server URL or credential-derived identity.
struct ProviderQuotasResponse: Codable, Equatable, Sendable {
    let version: Int?
    let scopeID: String?
    let profileID: String?
    let activeProvider: String?
    let requestedSourceID: String?
    let missingSource: Bool
    let sources: [ProviderQuotaSource]

    enum CodingKeys: String, CodingKey {
        case version
        case scopeID = "scopeId"
        case profileID = "profileId"
        case activeProvider
        case requestedSourceID = "requestedSourceId"
        case missingSource
        case sources
    }

    init(from decoder: Decoder) throws {
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

struct ProviderQuotaSource: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let providerID: String
    let providerLabel: String
    let accountLabel: String
    let isActiveProvider: Bool
    let supported: Bool
    let status: String
    let plan: String?
    let windows: [ProviderQuotaWindow]
    let quota: ProviderQuotaAmount?
    let details: [String]
    let unavailableReason: String?
    let retryAfter: String?
    let fetchedAt: String?
    let message: String?

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

    init(
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

    init(from decoder: Decoder) throws {
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

    func removed() -> ProviderQuotaSource {
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

struct ProviderQuotaWindow: Codable, Equatable, Sendable {
    let label: String
    let windowSeconds: Int?
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetAt: String?
    let detail: String?

    enum CodingKeys: String, CodingKey {
        case label
        case windowSeconds
        case usedPercent
        case remainingPercent
        case resetAt
        case detail
    }

    init(
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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = container.decodeQuotaStringIfPresent(forKey: .label) ?? String(localized: "Quota")
        windowSeconds = container.decodeQuotaIntIfPresent(forKey: .windowSeconds)
        usedPercent = container.decodeQuotaDoubleIfPresent(forKey: .usedPercent)
        remainingPercent = container.decodeQuotaDoubleIfPresent(forKey: .remainingPercent)
        resetAt = container.decodeQuotaStringIfPresent(forKey: .resetAt)
        detail = container.decodeQuotaStringIfPresent(forKey: .detail)
    }
}

struct ProviderQuotaAmount: Codable, Equatable, Sendable {
    let limitRemaining: Double?
    let usage: Double?
    let limit: Double?

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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        limitRemaining = container.decodeQuotaDoubleIfPresent(forKey: .limitRemaining)
        usage = container.decodeQuotaDoubleIfPresent(forKey: .usage)
        limit = container.decodeQuotaDoubleIfPresent(forKey: .limit)
    }
}

/// Compatibility shape for older servers that only expose the active provider.
struct LegacyProviderQuotaResponse: Decodable, Equatable, Sendable {
    let provider: String?
    let displayName: String?
    let supported: Bool?
    let status: String?
    let quota: ProviderQuotaAmount?
    let accountLimits: LegacyProviderQuotaLimits?
    let message: String?
}

struct LegacyProviderQuotaLimits: Decodable, Equatable, Sendable {
    let plan: String?
    let windows: [ProviderQuotaWindow]?
    let details: [String]?
    let available: Bool?
    let unavailableReason: String?
    let fetchedAt: String?
    let pool: LegacyProviderQuotaPool?
}

struct LegacyProviderQuotaPool: Decodable, Equatable, Sendable {
    let credentials: [LegacyProviderQuotaCredential]?
}

struct LegacyProviderQuotaCredential: Decodable, Equatable, Sendable {
    let label: String?
    let status: String?
    let plan: String?
    let windows: [ProviderQuotaWindow]?
    let details: [String]?
    let unavailableReason: String?
    let retryAfter: String?
    let fetchedAt: String?
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
