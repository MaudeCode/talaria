import Foundation

public struct ContextWindowSnapshot: Decodable, Equatable {
    let contextLength: Int?
    let thresholdTokens: Int?
    let lastPromptTokens: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let estimatedCost: Double?
    public let tokensPerSecond: Double?
    public let durationSeconds: Double?

    enum CodingKeys: String, CodingKey {
        case contextLength = "context_length"
        case thresholdTokens = "threshold_tokens"
        case lastPromptTokens = "last_prompt_tokens"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case estimatedCost = "estimated_cost"
        case tokensPerSecond = "tps"
        case durationSeconds = "duration_seconds"
    }

    public init(
        contextLength: Int?,
        thresholdTokens: Int?,
        lastPromptTokens: Int?,
        inputTokens: Int?,
        outputTokens: Int?,
        estimatedCost: Double?,
        tokensPerSecond: Double? = nil,
        durationSeconds: Double? = nil
    ) {
        self.contextLength = contextLength
        self.thresholdTokens = thresholdTokens
        self.lastPromptTokens = lastPromptTokens
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.estimatedCost = estimatedCost
        self.tokensPerSecond = tokensPerSecond
        self.durationSeconds = durationSeconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contextLength = container.decodeLossyIntIfPresent(forKey: .contextLength)
        thresholdTokens = container.decodeLossyIntIfPresent(forKey: .thresholdTokens)
        lastPromptTokens = container.decodeLossyIntIfPresent(forKey: .lastPromptTokens)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        estimatedCost = container.decodeLossyDoubleIfPresent(forKey: .estimatedCost)
        tokensPerSecond = container.decodeLossyDoubleIfPresent(forKey: .tokensPerSecond)
        durationSeconds = container.decodeLossyDoubleIfPresent(forKey: .durationSeconds)
    }

    var tokensUsed: Int? {
        lastPromptTokens ?? inputTokens
    }

    public var percentage: Double? {
        guard let used = tokensUsed, let total = contextLength, total > 0 else { return nil }
        return Double(used) / Double(total)
    }

    public func replacingTokensUsed(_ tokens: Int?) -> ContextWindowSnapshot {
        guard let tokens else { return self }

        return ContextWindowSnapshot(
            contextLength: contextLength,
            thresholdTokens: thresholdTokens,
            lastPromptTokens: tokens,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            estimatedCost: estimatedCost,
            tokensPerSecond: tokensPerSecond,
            durationSeconds: durationSeconds
        )
    }
}

public enum ContextWindowFormatter {
    static func compactIndicator(from snapshot: ContextWindowSnapshot) -> String? {
        guard let used = snapshot.tokensUsed, let total = snapshot.contextLength, total > 0 else {
            return nil
        }
        let pct = Int((Double(used) / Double(total)) * 100)
        return String(localized: "\(pct)% context")
    }

    public static func tokensLabel(from snapshot: ContextWindowSnapshot) -> String {
        guard let used = snapshot.tokensUsed, let total = snapshot.contextLength else {
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
