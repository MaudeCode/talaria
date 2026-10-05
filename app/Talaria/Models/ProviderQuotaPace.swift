import AppIntents
import Foundation
import SwiftUI
import WidgetKit
import TalariaKit

enum ProviderQuotaForecastOutcome: Equatable {
    case unavailable
    case safe
    case warning
}

struct ProviderQuotaForecastSummary {
    let burnRateLabel: String
    let budgetTitle: String
    let budgetLabel: String
    let forecastLabel: String
    let systemImage: String
    let outcome: ProviderQuotaForecastOutcome

    init(state: ProviderQuotaPresentationState) {
        guard let pace = state.pace, let forecast = state.forecast else {
            burnRateLabel = "—"
            budgetTitle = String(localized: "Budget / hr")
            budgetLabel = "—"
            forecastLabel = state.paceNeedsRefresh
                ? String(localized: "Refresh needed")
                : String(localized: "Forecast unavailable")
            systemImage = state.paceNeedsRefresh ? "arrow.clockwise.circle" : "questionmark.circle"
            outcome = .unavailable
            return
        }

        burnRateLabel = "\(pace.burnRate.formatted(.number.precision(.fractionLength(2))))×"
        budgetTitle = forecast.budgetUnit == .day
            ? String(localized: "Budget / day")
            : String(localized: "Budget / hr")
        budgetLabel = forecast.budgetPercent?
            .formatted(.percent.scale(1).precision(.fractionLength(0...1))) ?? "—"

        switch (forecast.outcome, forecast.depletionMarginMinutes) {
        case (.warning, let margin):
            forecastLabel = String(localized: "Empty \(Self.durationLabel(abs(margin ?? 0))) early")
            systemImage = "exclamationmark.triangle"
            outcome = .warning
        case (.safe, nil):
            forecastLabel = String(localized: "No depletion projected")
            systemImage = "checkmark.circle"
            outcome = .safe
        case (.safe, _):
            forecastLabel = String(localized: "Lasts through reset")
            systemImage = "checkmark.circle"
            outcome = .safe
        }
    }

    private static func durationLabel(_ minutes: Double) -> String {
        let totalMinutes = max(0, Int(minutes.rounded()))
        let days = totalMinutes / (24 * 60)
        let hours = totalMinutes % (24 * 60) / 60
        if days > 0 { return String(localized: "\(days)d \(hours)h") }
        if hours > 0 { return String(localized: "\(hours)h") }
        return String(localized: "\(totalMinutes)m")
    }
}

enum ProviderQuotaDisplayWindow {
    /// The server names the pace, session, and weekly windows; `automatic` otherwise shows the first window.
    static func window(
        for source: ProviderQuotaWidgetSource,
        basis: ProviderQuotaWidgetColorBasis,
        selection: ProviderQuotaWidgetWindowSelection = .automatic
    ) -> ProviderQuotaWindow? {
        let index: Int? = switch selection {
        case .session: source.sessionWindowIndex
        case .weekly: source.weeklyWindowIndex
        case .automatic: basis == .pace ? source.paceWindowIndex ?? 0 : 0
        }
        guard let index, source.windows.indices.contains(index) else { return nil }
        return source.windows[index]
    }
}
