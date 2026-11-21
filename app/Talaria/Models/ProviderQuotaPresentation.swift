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
        let window = windowOverride ?? ProviderQuotaDisplayWindow.window(
            for: source,
            basis: settings.colorBasis,
            selection: settings.windowSelection
        )
        let credits = source.quota.flatMap(creditPercents)
        // The server ships both window and credit percents normalized (TAL-1782, TAL-45); the mode only picks one.
        let displayedPercent = window.flatMap { settings.percentageMode == .used ? $0.usedPercent : $0.remainingPercent }
            ?? credits.map { settings.percentageMode == .used ? $0.used : $0.remaining }
        let remaining = window?.remainingPercent ?? credits?.remaining
        // The server flags a pace its read saw expire; a cached copy's pace also expires at its own `validUntil`.
        let paceExpired = window?.paceNeedsRefresh == true || window?.pace?.isValid(at: referenceDate) == false
        let pace = paceExpired ? nil : window?.pace
        let isStale = source.isStale(at: referenceDate)
        // The server classifies (TAL-411); an old cache shows stale, and a server without `urgency` stays neutral.
        let serverUrgency = source.status == "available" ? (window?.urgency ?? source.urgency) : (source.urgency ?? window?.urgency)
        let urgency: ProviderQuotaUrgency = isStale ? .stale : serverUrgency?.level(for: settings.colorBasis) ?? .healthy
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

    /// The server's percents of a credit cap; nil when uncapped. TAL-2624 deletes the fallback for a server without them.
    private static func creditPercents(_ quota: ProviderQuotaAmount) -> (used: Double, remaining: Double)? {
        if quota.isCapped != nil {
            guard let used = quota.percentUsed, let remaining = quota.percentRemaining else { return nil }
            return (used, remaining)
        }
        guard let usage = quota.usage, let limit = quota.limit, limit > 0 else { return nil }
        let used = min(max(usage / limit * 100, 0), 100)
        return (used, 100 - used)
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
