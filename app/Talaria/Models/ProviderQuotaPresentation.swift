import AppIntents
import Foundation
import SwiftUI
import WidgetKit
import TalariaKit

enum ProviderQuotaWidgetSelection {
    static func sourceIDs(slotIDs: [String?], capacity: Int) -> [String] {
        slotIDs.prefix(max(0, min(capacity, 4))).compactMap { raw in
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    static func resolve(
        sourceIDs: [String],
        snapshot: ProviderQuotaWidgetSnapshot?
    ) -> [ProviderQuotaWidgetSource?] {
        let byID = Dictionary(uniqueKeysWithValues: (snapshot?.sources ?? []).map { ($0.sourceID, $0) })
        return sourceIDs.map { byID[$0] }
    }
}

enum ProviderQuotaPresentation {
    static func state(
        for source: ProviderQuotaWidgetSource,
        settings: ProviderQuotaEvaluationSettings,
        at referenceDate: Date,
        windowOverride: ProviderQuotaWindow? = nil
    ) -> ProviderQuotaPresentationState {
        let window = windowOverride ?? ProviderQuotaUrgencyCalculator.displayWindow(
            for: source,
            basis: settings.colorBasis,
            selection: settings.windowSelection
        )
        let usedFromQuota: Double? = {
            guard let usage = source.quota?.usage,
                  let limit = source.quota?.limit,
                  limit > 0
            else { return nil }
            return min(max(usage / limit * 100, 0), 100)
        }()
        let displayedPercent = window.flatMap { percent($0, mode: settings.percentageMode) }
            ?? usedFromQuota.map { settings.percentageMode == .used ? $0 : 100 - $0 }
        let remaining = window.flatMap { percent($0, mode: .remaining) }
            ?? usedFromQuota.map { 100 - $0 }
        // A cached pace past its window's reset describes the previous window.
        let pace = window?.pace.flatMap { $0.isValid(at: referenceDate) ? $0 : nil }
        let isStale = referenceDate.timeIntervalSince(source.freshnessDate) > ProviderQuotaWidgetSnapshot.staleAfter
        let urgency = ProviderQuotaUrgencyCalculator.urgency(
            window: window,
            pace: pace,
            status: source.status,
            isStale: isStale,
            basis: settings.colorBasis,
            warningRemainingPercent: settings.warningRemainingPercent,
            criticalRemainingPercent: settings.criticalRemainingPercent,
            paceTolerancePercent: settings.paceTolerancePercent,
            paceWarningBurnRatePercent: settings.paceWarningBurnRatePercent,
            paceCriticalBurnRatePercent: settings.paceCriticalBurnRatePercent,
            paceMinimumElapsedHours: settings.paceMinimumElapsedHours
        )
        return ProviderQuotaPresentationState(
            window: window,
            percent: displayedPercent,
            remainingPercent: remaining,
            resetAt: ProviderQuotaDateParser.date(from: window?.resetAt),
            referenceDate: referenceDate,
            freshnessDate: source.freshnessDate,
            isStale: isStale,
            pace: pace,
            urgency: urgency,
            settings: settings,
            forecast: pace == nil ? nil : window?.forecast,
            paceNeedsRefresh: window?.pace != nil && pace == nil,
            computedAt: ProviderQuotaDateParser.date(from: source.computedAt)
        )
    }

    static func periods(
        for source: ProviderQuotaWidgetSource,
        settings: ProviderQuotaEvaluationSettings,
        at referenceDate: Date
    ) -> [ProviderQuotaPeriodPresentation] {
        displayWindows(from: source.windows).enumerated().map { index, window in
            ProviderQuotaPeriodPresentation(
                id: index,
                shortLabel: shortLabel(for: window),
                state: state(
                    for: source,
                    settings: settings,
                    at: referenceDate,
                    windowOverride: window
                )
            )
        }
    }

    static func displayWindows(from windows: [ProviderQuotaWindow]) -> [ProviderQuotaWindow] {
        let indexed = Array(windows.enumerated())
        let ordered = indexed.allSatisfy { $0.element.windowSeconds != nil }
            ? indexed.sorted {
                let lhs = $0.element.windowSeconds ?? 0
                let rhs = $1.element.windowSeconds ?? 0
                return lhs == rhs ? $0.offset < $1.offset : lhs < rhs
            }
            : indexed
        return ordered.prefix(3).map(\.element)
    }

    static func shortLabel(for window: ProviderQuotaWindow) -> String {
        if window.windowSeconds == 18_000 { return "5h" }
        if window.windowSeconds == 604_800 { return String(localized: "Week") }
        if window.label.localizedCaseInsensitiveContains("month") {
            return String(localized: "Month")
        }
        if window.label.localizedCaseInsensitiveContains("week") {
            return String(localized: "Week")
        }
        if window.label.localizedCaseInsensitiveContains("5h") {
            return "5h"
        }
        return String(window.label.prefix(8))
    }

    static func usedPercent(_ window: ProviderQuotaWindow) -> Double? {
        if let used = window.usedPercent, used.isFinite { return min(max(used, 0), 100) }
        if let remaining = window.remainingPercent, remaining.isFinite { return min(max(100 - remaining, 0), 100) }
        return nil
    }

    static func percent(_ window: ProviderQuotaWindow, mode: ProviderQuotaPercentageMode) -> Double? {
        guard let used = usedPercent(window) else { return nil }
        return mode == .used ? used : 100 - used
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "available": String(localized: "Available")
        case "exhausted": String(localized: "Quota exhausted")
        case "invalid_key", "no_key": String(localized: "Authentication required")
        case "removed": String(localized: "Account removed")
        case "unsupported": String(localized: "Quota not supported")
        case "dead": String(localized: "Credential unavailable")
        default: String(localized: "Quota unavailable")
        }
    }
}
