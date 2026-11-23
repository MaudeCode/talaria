import SwiftUI

/// Formats an assistant turn's unix `timestamp` as a short, locale-/24h-aware
/// time (e.g. `2:14 PM` or `14:14`). Returns `nil` for a missing or non-finite
/// timestamp so the per-turn header falls back to glyph-only.
public enum AssistantTurnTimestampFormatter {
    private static let sharedFormatter: DateFormatter = makeFormatter(
        locale: .autoupdatingCurrent,
        timeZone: .autoupdatingCurrent
    )

    public static func shortTime(forUnixTimestamp timestamp: Double?) -> String? {
        format(timestamp, with: sharedFormatter)
    }

    static func makeFormatter(locale: Locale, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }

    static func format(_ timestamp: Double?, with formatter: DateFormatter) -> String? {
        guard let timestamp, timestamp.isFinite else { return nil }
        return formatter.string(from: Date(timeIntervalSince1970: timestamp))
    }
}

public enum ResponseSpeedFormatter {
    public static func compactText(_ tokensPerSecond: Double?, locale: Locale = .autoupdatingCurrent) -> String? {
        guard let tokensPerSecond, tokensPerSecond.isFinite, tokensPerSecond > 0 else { return nil }
        let value = tokensPerSecond.formatted(
            .number.locale(locale).precision(.fractionLength(1))
        )
        return "\(value) t/s"
    }

    public static func accessibilityText(
        _ tokensPerSecond: Double?,
        locale: Locale = .autoupdatingCurrent
    ) -> String? {
        guard let compact = compactText(tokensPerSecond, locale: locale) else { return nil }
        let value = compact.dropLast(4)
        return "\(value) \(String(localized: "tokens per second"))"
    }
}

/// TAL-1077: a reply's own usage in the reader's words. Every figure is the server's (`TurnUsage`); one it could not
/// give, such as the cost of an unpriced model, is left out rather than shown empty.
public enum TurnUsageFormatter {
    /// The header's compact figures ("1.2K in · 134 out").
    public static func compactText(_ usage: TurnUsage, locale: Locale = .autoupdatingCurrent) -> String {
        let input = insightsCompactNumber(usage.inputTokens, locale: locale)
        let output = insightsCompactNumber(usage.outputTokens, locale: locale)
        return String(localized: "\(input) in · \(output) out")
    }

    /// The same figures spoken whole, with their unit.
    public static func accessibilityText(_ usage: TurnUsage, locale: Locale = .autoupdatingCurrent) -> String {
        let input = formatTokens(usage.inputTokens, locale: locale)
        let output = formatTokens(usage.outputTokens, locale: locale)
        return String(localized: "\(input) input tokens, \(output) output tokens")
    }

    /// The details a tap on the figures opens: exact counts, then the cache-hit rate and estimated cost when the server has them.
    public static func detailRows(_ usage: TurnUsage, locale: Locale = .autoupdatingCurrent) -> [(label: String, value: String)] {
        func tokens(_ count: Int) -> String { String(localized: "\(formatTokens(count, locale: locale)) tokens") }
        var rows = [
            (String(localized: "Input"), tokens(usage.inputTokens)),
            (String(localized: "Output"), tokens(usage.outputTokens)),
            (String(localized: "Cache read"), tokens(usage.cacheReadTokens)),
            (String(localized: "Cache write"), tokens(usage.cacheWriteTokens)),
        ]
        if let percent = usage.cacheHitPercent {
            rows.append((String(localized: "Cache hit"), insightsFormattedPercent(Double(percent), locale: locale)))
        }
        if let cost = usage.estimatedCost {
            rows.append((String(localized: "Estimated cost"), cost.formattedCost(locale: locale)))
        }
        return rows.map { (label: $0.0, value: $0.1) }
    }
}
