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
        guard let pace = state.pace else {
            burnRateLabel = "—"
            budgetTitle = String(localized: "Budget / hr")
            budgetLabel = "—"
            forecastLabel = String(localized: "Forecast unavailable")
            systemImage = "questionmark.circle"
            outcome = .unavailable
            return
        }

        burnRateLabel = "\(pace.burnRate.formatted(.number.precision(.fractionLength(2))))×"
        let usesDailyBudget = pace.minutesToReset >= 24 * 60
        budgetTitle = usesDailyBudget
            ? String(localized: "Budget / day")
            : String(localized: "Budget / hr")
        if let remaining = state.remainingPercent, pace.minutesToReset > 0 {
            let divisor = usesDailyBudget
                ? pace.minutesToReset / (24 * 60)
                : pace.minutesToReset / 60
            budgetLabel = (remaining / divisor)
                .formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        } else {
            budgetLabel = "—"
        }

        guard let projected = pace.projectedMinutesToEmpty else {
            forecastLabel = String(localized: "No depletion projected")
            systemImage = "checkmark.circle"
            outcome = .safe
            return
        }
        let margin = projected - pace.minutesToReset
        if margin >= 0 {
            forecastLabel = String(localized: "Lasts through reset")
            systemImage = "checkmark.circle"
            outcome = .safe
        } else {
            forecastLabel = String(localized: "Empty \(Self.durationLabel(abs(margin))) early")
            systemImage = "exclamationmark.triangle"
            outcome = .warning
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




enum ProviderQuotaUrgencyCalculator {
    static func displayWindow(
        from windows: [ProviderQuotaWindow],
        basis: ProviderQuotaWidgetColorBasis,
        selection: ProviderQuotaWidgetWindowSelection = .automatic
    ) -> ProviderQuotaWindow? {
        switch selection {
        case .session:
            return windows.first(where: { $0.label.localizedCaseInsensitiveContains("session") })
                ?? windows.first(where: { $0.label.localizedCaseInsensitiveContains("5h") })
        case .weekly:
            return windows.first(where: { $0.label.localizedCaseInsensitiveContains("week") })
        case .automatic:
            if basis == .pace {
                return windows.first(where: { $0.label.localizedCaseInsensitiveContains("week") })
                    ?? windows.first(where: { isKnownPaceWindow($0) })
            }
            return windows.first
        }
    }

    static func pace(
        for window: ProviderQuotaWindow?,
        referenceDate: Date,
        minimumElapsedHours: Int
    ) -> ProviderQuotaPace? {
        guard let window,
              let resetAt = ProviderQuotaDateParser.date(from: window.resetAt),
              resetAt > referenceDate,
              let used = ProviderQuotaPresentation.usedPercent(window),
              let remaining = ProviderQuotaPresentation.percent(window, mode: .remaining)
        else { return nil }

        let minutesToReset = max(0, (resetAt.timeIntervalSince(referenceDate) / 60).rounded())
        guard let windowMinutes = windowMinutes(for: window, minutesToReset: minutesToReset) else {
            return nil
        }
        let elapsedMinutes = max(0, Double(windowMinutes) - minutesToReset)
        let expectedRemaining = rounded(
            min(max(minutesToReset / Double(windowMinutes) * 100, 0), 100),
            digits: 1
        )
        let paceDelta = rounded(remaining - expectedRemaining, digits: 1)
        let expectedUsed = rounded(100 - expectedRemaining, digits: 1)
        let burnRate = expectedUsed > 0 ? rounded(used / expectedUsed, digits: 2) : 0
        let usagePerMinute = elapsedMinutes > 0 ? used / elapsedMinutes : 0
        let projectedMinutesToEmpty = usagePerMinute > 0 ? (remaining / usagePerMinute).rounded() : nil
        let projectionEligible = elapsedMinutes >= Double(max(0, minimumElapsedHours) * 60)
            && used >= 5
            && minutesToReset > 20
            && (projectedMinutesToEmpty ?? .infinity) < minutesToReset
        return ProviderQuotaPace(
            expectedRemainingPercent: expectedRemaining,
            paceDeltaPercent: paceDelta,
            burnRate: burnRate,
            minutesToReset: minutesToReset,
            projectedMinutesToEmpty: projectedMinutesToEmpty,
            projectionEligible: projectionEligible
        )
    }

    static func urgency(
        windows: [ProviderQuotaWindow],
        status: String,
        isStale: Bool,
        referenceDate: Date = Date(),
        basis: ProviderQuotaWidgetColorBasis,
        warningRemainingPercent: Int,
        criticalRemainingPercent: Int,
        paceTolerancePercent: Int,
        paceWarningBurnRatePercent: Int,
        paceCriticalBurnRatePercent: Int,
        paceMinimumElapsedHours: Int,
        windowSelection: ProviderQuotaWidgetWindowSelection = .automatic
    ) -> ProviderQuotaUrgency {
        if isStale { return .stale }
        guard status == "available",
              let window = displayWindow(from: windows, basis: basis, selection: windowSelection),
              let remaining = ProviderQuotaPresentation.percent(window, mode: .remaining)
        else {
            return status == "available" ? .healthy : .unavailable
        }

        if basis == .pace,
           let pace = pace(for: window, referenceDate: referenceDate, minimumElapsedHours: paceMinimumElapsedHours) {
            if pace.projectionEligible && pace.burnRate >= Double(max(0, paceCriticalBurnRatePercent)) / 100 {
                return .critical
            }
            if pace.projectionEligible && pace.burnRate >= Double(max(0, paceWarningBurnRatePercent)) / 100 {
                return .warning
            }
            return pace.paceDeltaPercent <= -Double(max(0, paceTolerancePercent)) ? .warning : .healthy
        }

        if remaining <= Double(max(0, criticalRemainingPercent)) { return .critical }
        if remaining <= Double(max(0, warningRemainingPercent)) { return .warning }
        return .healthy
    }

    private static func rounded(_ value: Double, digits: Int) -> Double {
        let scale = pow(10, Double(digits))
        return (value * scale).rounded() / scale
    }

    private static func isKnownPaceWindow(_ window: ProviderQuotaWindow) -> Bool {
        window.windowSeconds == 18_000
            || window.windowSeconds == 604_800
            || window.label.localizedCaseInsensitiveContains("week")
            || window.label.localizedCaseInsensitiveContains("session")
            || window.label.localizedCaseInsensitiveContains("5h")
    }

    private static func windowMinutes(for window: ProviderQuotaWindow, minutesToReset: Double) -> Int? {
        if let seconds = window.windowSeconds {
            if seconds == 18_000 { return 5 * 60 }
            if seconds == 604_800 { return 7 * 24 * 60 }
            return nil
        }
        if window.label.localizedCaseInsensitiveContains("week") { return 7 * 24 * 60 }
        if window.label.localizedCaseInsensitiveContains("5h") { return 5 * 60 }
        if window.label.localizedCaseInsensitiveContains("session") {
            return minutesToReset > 5 * 60 ? 7 * 24 * 60 : 5 * 60
        }
        return nil
    }
}
