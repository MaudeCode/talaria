import SwiftUI

/// Formats a token count with the locale's digit grouping ("1,234,567").
public func formatTokens(_ value: Int, locale: Locale = .current) -> String {
    value.formatted(.number.locale(locale))
}

/// Formats a server-reported 0–100 percentage (e.g. `cache_hit_percent`) with a
/// localized percent symbol and at most one fraction digit ("87.5%", "12%").
public func insightsFormattedPercent(_ value: Double, locale: Locale = .current) -> String {
    (value / 100).formatted(.percent.precision(.fractionLength(0...1)).locale(locale))
}

/// Formats a count the way a stat tile or chart axis reads it ("1.2M", "48K"); the exact figure stays in the
/// accessibility label.
public func insightsCompactNumber(_ value: Int, locale: Locale = .current) -> String {
    value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)).locale(locale))
}
