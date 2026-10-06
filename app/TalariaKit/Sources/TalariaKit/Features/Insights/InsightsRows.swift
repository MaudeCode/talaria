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
