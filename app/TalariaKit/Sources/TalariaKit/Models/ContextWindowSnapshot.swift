import Foundation

/// The context ring's figures. The server computes the used tokens, the window, and both percents (TAL-299);
/// a nil figure means unknown, and the ring then shows no percentage.
public struct ContextWindowSnapshot: Decodable, Equatable {
    let contextUsedTokens: Int?
    let contextWindowTokens: Int?
    let contextUsagePercent: Int?
    let contextThresholdPercent: Int?
    let thresholdTokens: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let estimatedCost: Double?
    public let tokensPerSecond: Double?
    public let durationSeconds: Double?

    enum CodingKeys: String, CodingKey {
        case contextUsedTokens = "context_used_tokens"
        case contextWindowTokens = "context_window_tokens"
        case contextUsagePercent = "context_usage_percent"
        case contextThresholdPercent = "context_threshold_percent"
        case thresholdTokens = "threshold_tokens"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case estimatedCost = "estimated_cost"
        case tokensPerSecond = "tps"
        case durationSeconds = "duration_seconds"
    }

    public init(
        contextUsedTokens: Int?,
        contextWindowTokens: Int?,
        contextUsagePercent: Int?,
        contextThresholdPercent: Int? = nil,
        thresholdTokens: Int?,
        inputTokens: Int?,
        outputTokens: Int?,
        estimatedCost: Double?,
        tokensPerSecond: Double? = nil,
        durationSeconds: Double? = nil
    ) {
        self.contextUsedTokens = contextUsedTokens
        self.contextWindowTokens = contextWindowTokens
        self.contextUsagePercent = contextUsagePercent
        self.contextThresholdPercent = contextThresholdPercent
        self.thresholdTokens = thresholdTokens
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.estimatedCost = estimatedCost
        self.tokensPerSecond = tokensPerSecond
        self.durationSeconds = durationSeconds
    }

    public init(session: SessionDetail) {
        self.init(
            contextUsedTokens: session.contextUsedTokens,
            contextWindowTokens: session.contextWindowTokens,
            contextUsagePercent: session.contextUsagePercent,
            contextThresholdPercent: session.contextThresholdPercent,
            thresholdTokens: session.thresholdTokens,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            estimatedCost: session.estimatedCost
        )
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contextUsedTokens = container.decodeLossyIntIfPresent(forKey: .contextUsedTokens)
        contextWindowTokens = container.decodeLossyIntIfPresent(forKey: .contextWindowTokens)
        contextUsagePercent = container.decodeLossyIntIfPresent(forKey: .contextUsagePercent)
        contextThresholdPercent = container.decodeLossyIntIfPresent(forKey: .contextThresholdPercent)
        thresholdTokens = container.decodeLossyIntIfPresent(forKey: .thresholdTokens)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        estimatedCost = container.decodeLossyDoubleIfPresent(forKey: .estimatedCost)
        tokensPerSecond = container.decodeLossyDoubleIfPresent(forKey: .tokensPerSecond)
        durationSeconds = container.decodeLossyDoubleIfPresent(forKey: .durationSeconds)
    }
}

public enum ContextWindowFormatter {
    public static func tokensLabel(from snapshot: ContextWindowSnapshot) -> String {
        guard let used = snapshot.contextUsedTokens, let total = snapshot.contextWindowTokens else {
            return String(localized: "Unavailable")
        }
        return "\(formatTokens(used)) / \(formatTokens(total))"
    }

    public static func inputTokensLabel(from snapshot: ContextWindowSnapshot) -> String {
        guard let tokens = snapshot.inputTokens else { return String(localized: "Unavailable") }
        return formatTokens(tokens)
    }

    public static func outputTokensLabel(from snapshot: ContextWindowSnapshot) -> String {
        guard let tokens = snapshot.outputTokens else { return String(localized: "Unavailable") }
        return formatTokens(tokens)
    }

    public static func thresholdLabel(from snapshot: ContextWindowSnapshot) -> String {
        guard let threshold = snapshot.thresholdTokens, threshold > 0 else {
            return String(localized: "Unavailable")
        }
        return formatTokens(threshold)
    }

    public static func costLabel(from snapshot: ContextWindowSnapshot) -> String {
        guard let cost = snapshot.estimatedCost else {
            return String(localized: "Unavailable")
        }
        return cost.formattedCost()
    }

    static func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fK", Double(count) / 1_000)
        } else {
            return "\(count)"
        }
    }
}

extension Double {
    public func formattedCost(collapsingZeroCents: Bool = false) -> String {
        if collapsingZeroCents && self == 0 {
            return "$0.00"
        }
        return String(format: "$%.4f", self)
    }
}
