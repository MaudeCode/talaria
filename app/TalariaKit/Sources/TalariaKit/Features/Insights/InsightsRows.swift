import SwiftUI

public func formatTokens(_ value: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

/// Formats a server-reported 0–100 percentage (e.g. `cache_hit_percent`) with a
/// localized percent symbol and at most one fraction digit ("87.5%", "12%").
public func insightsFormattedPercent(_ value: Double, locale: Locale = .current) -> String {
    (value / 100).formatted(.percent.precision(.fractionLength(0...1)).locale(locale))
}
