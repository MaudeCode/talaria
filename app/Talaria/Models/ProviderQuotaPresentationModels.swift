import AppIntents
import Foundation
import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaEvaluationSettings: Equatable {
    let percentageMode: ProviderQuotaPercentageMode
    let colorBasis: ProviderQuotaWidgetColorBasis
    let windowSelection: ProviderQuotaWidgetWindowSelection

    static func stored(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults,
        configuration: ProviderQuotaWidgetConfigurationIntent? = nil,
        profileID: String? = nil,
        followsSelectedDefault: Bool = true
    ) -> ProviderQuotaEvaluationSettings {
        let profile = ProviderQuotaWidgetResolvedProfile.resolve(
            id: profileID ?? configuration?.profile?.id,
            followsSelectedDefault: followsSelectedDefault,
            defaults: defaults
        )
        let defaultPercentage = ProviderQuotaPercentageMode(
            rawValue: profile.string(ProviderQuotaPercentageMode.storageKey)
        ) ?? .defaultValue
        let defaultBasis = ProviderQuotaWidgetColorBasis(
            rawValue: profile.string(ProviderQuotaWidgetColorBasis.storageKey)
        ) ?? .defaultValue
        let usesSavedProfile = profile.id != ProviderQuotaWidgetProfileStore.defaultProfileID
        return ProviderQuotaEvaluationSettings(
            percentageMode: usesSavedProfile ? defaultPercentage : configuration?.percentageMode.resolved(default: defaultPercentage) ?? defaultPercentage,
            colorBasis: usesSavedProfile ? defaultBasis : configuration?.colorBasis.resolved(default: defaultBasis) ?? defaultBasis,
            windowSelection: usesSavedProfile
                ? ProviderQuotaWidgetWindowSelection(rawValue: profile.string(ProviderQuotaWidgetWindowSelection.storageKey)) ?? .defaultValue
                : configuration?.windowSelection ?? .defaultValue
        )
    }
}

struct ProviderQuotaPresentationState: Equatable {
    let window: ProviderQuotaWindow?
    let percent: Double?
    let remainingPercent: Double?
    let resetAt: Date?
    let referenceDate: Date
    let freshnessDate: Date
    let isStale: Bool
    /// The window's server pace while it is still valid at `referenceDate`.
    let pace: ProviderQuotaWindowPace?
    let urgency: ProviderQuotaUrgency
    let settings: ProviderQuotaEvaluationSettings
    var forecast: ProviderQuotaWindowForecast? = nil
    /// The cached pace expired at its window's reset; only a refresh brings the new window's pace.
    var paceNeedsRefresh = false
    /// The server time the pace and forecast describe.
    var computedAt: Date? = nil

    var expectedPercent: Double? {
        guard let expectedRemaining = pace?.expectedRemainingPercent else { return nil }
        return settings.percentageMode == .used ? 100 - expectedRemaining : expectedRemaining
    }

    var modeLabel: String {
        settings.percentageMode == .used ? String(localized: "used") : String(localized: "remaining")
    }

    /// Wording for the server's `pace.status`; nil from a server that predates it.
    var paceLabel: String? {
        guard let pace, let status = pace.status else { return nil }
        let value = abs(pace.paceDeltaPercent).formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        return switch status {
        case "over": String(localized: "\(value) over pace")
        case "under": String(localized: "\(value) under pace")
        case "on": String(localized: "On pace")
        default: nil
        }
    }

    func withUrgency(_ urgency: ProviderQuotaUrgency) -> ProviderQuotaPresentationState {
        ProviderQuotaPresentationState(
            window: window,
            percent: percent,
            remainingPercent: remainingPercent,
            resetAt: resetAt,
            referenceDate: referenceDate,
            freshnessDate: freshnessDate,
            isStale: urgency == .stale || isStale,
            pace: pace,
            urgency: urgency,
            settings: settings,
            forecast: forecast,
            paceNeedsRefresh: paceNeedsRefresh,
            computedAt: computedAt
        )
    }
}

enum ProviderQuotaSidebarDetail: String, CaseIterable, Identifiable {
    case percentage
    case pace
    case reset
    case freshness
    case hidden

    static let defaultValue = ProviderQuotaSidebarDetail.percentage

    var id: String { rawValue }
    var title: String {
        switch self {
        case .percentage: String(localized: "Percentage")
        case .pace: String(localized: "Pace")
        case .reset: String(localized: "Reset")
        case .freshness: String(localized: "Updated")
        case .hidden: String(localized: "None")
        }
    }
}

struct ProviderQuotaSidebarDisplayOptions: Equatable {
    let detail: ProviderQuotaSidebarDetail
    let showsRail: Bool
    let requestsPaceMarker: Bool
    let showsIcon: Bool
    let colorsByState: Bool

    var showsPaceMarker: Bool { showsRail && requestsPaceMarker }
}

enum ProviderQuotaSidebarPresentation {
    static func detail(
        mode: ProviderQuotaSidebarDetail,
        source: ProviderQuotaWidgetSource,
        state: ProviderQuotaPresentationState
    ) -> String? {
        switch mode {
        case .hidden:
            nil
        case .pace:
            state.paceLabel ?? ProviderQuotaPresentation.statusLabel(source.status)
        case .reset:
            state.resetAt?.formatted(.relative(presentation: .numeric))
                ?? ProviderQuotaPresentation.statusLabel(source.status)
        case .freshness:
            state.freshnessDate.formatted(.relative(presentation: .numeric))
        case .percentage:
            state.percent.map {
                "\(($0 / 100).formatted(.percent.precision(.fractionLength(0...1)))) \(state.modeLabel)"
            }
                ?? ProviderQuotaPresentation.statusLabel(source.status)
        }
    }
}

struct ProviderQuotaPeriodPresentation: Equatable, Identifiable {
    let id: Int
    let shortLabel: String
    let state: ProviderQuotaPresentationState

    func valueLabel(statusText: ProviderQuotaWidgetStatusText) -> String? {
        switch statusText {
        case .hidden:
            nil
        case .pace:
            state.paceLabel
                ?? state.percent?.formatted(.percent.scale(1).precision(.fractionLength(0)))
        case .appDefault, .percentage:
            state.percent?.formatted(.percent.scale(1).precision(.fractionLength(0)))
                ?? "—"
        }
    }

    func resetLabel(display: ProviderQuotaWidgetResetDisplay) -> String? {
        guard display != .hidden, let resetAt = state.resetAt else { return nil }
        if display == .exact {
            return resetAt.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        }
        let minutes = max(0, Int(resetAt.timeIntervalSince(state.referenceDate) / 60))
        let days = minutes / (24 * 60)
        let hours = minutes % (24 * 60) / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(minutes)m"
    }

    func accessibilityDescription(resetDisplay: ProviderQuotaWidgetResetDisplay) -> String {
        let value = state.percent?.formatted(
            .percent.scale(1).precision(.fractionLength(0...1))
        ) ?? String(localized: "unavailable")
        let reset = resetLabel(display: resetDisplay).map { ", resets in \($0)" } ?? ""
        return "\(shortLabel), \(value) \(state.modeLabel)\(reset)"
    }
}
