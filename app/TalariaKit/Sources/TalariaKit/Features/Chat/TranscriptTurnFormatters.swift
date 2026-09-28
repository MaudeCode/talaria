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

    /// Test seam: format against an explicit locale/time zone so 12h/24h
    /// assertions stay deterministic regardless of host device settings.
    public static func shortTime(
        forUnixTimestamp timestamp: Double?,
        locale: Locale,
        timeZone: TimeZone
    ) -> String? {
        format(timestamp, with: makeFormatter(locale: locale, timeZone: timeZone))
    }

    private static func makeFormatter(locale: Locale, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }

    private static func format(_ timestamp: Double?, with formatter: DateFormatter) -> String? {
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
