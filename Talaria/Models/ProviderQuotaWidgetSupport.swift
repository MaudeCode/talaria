import AppIntents
import Foundation
import SwiftUI
import WidgetKit

enum ProviderQuotaPercentageMode: String, CaseIterable, Identifiable {
    case used
    case remaining

    static let storageKey = "providerQuota.percentageMode"
    static let defaultValue = ProviderQuotaPercentageMode.used

    var id: String { rawValue }
    var title: String {
        switch self {
        case .used: String(localized: "Used")
        case .remaining: String(localized: "Remaining")
        }
    }
}

enum ProviderQuotaWidgetArcColor: String, CaseIterable, Identifiable {
    case automatic
    case accent
    case blue
    case cyan
    case green
    case indigo
    case mint
    case orange
    case pink
    case purple
    case red
    case teal
    case yellow
    case brown
    case gray
    case custom

    static let storageKey = "providerQuota.widgetArcColor"
    static let defaultValue = ProviderQuotaWidgetArcColor.automatic

    var id: String { rawValue }
    var title: String {
        switch self {
        case .automatic: String(localized: "Automatic")
        case .accent: String(localized: "Accent")
        case .blue: String(localized: "Blue")
        case .cyan: String(localized: "Cyan")
        case .green: String(localized: "Green")
        case .indigo: String(localized: "Indigo")
        case .mint: String(localized: "Mint")
        case .orange: String(localized: "Orange")
        case .pink: String(localized: "Pink")
        case .purple: String(localized: "Purple")
        case .red: String(localized: "Red")
        case .teal: String(localized: "Teal")
        case .yellow: String(localized: "Yellow")
        case .brown: String(localized: "Brown")
        case .gray: String(localized: "Gray")
        case .custom: String(localized: "Custom")
        }
    }
}

enum ProviderQuotaWidgetArcWeight: String, CaseIterable, Identifiable {
    case thin
    case regular
    case bold

    static let storageKey = "providerQuota.widgetArcWeight"
    static let defaultValue = ProviderQuotaWidgetArcWeight.regular

    var id: String { rawValue }
    var title: String {
        switch self {
        case .thin: String(localized: "Thin")
        case .regular: String(localized: "Regular")
        case .bold: String(localized: "Bold")
        }
    }
}

enum ProviderQuotaWidgetColorBasis: String, CaseIterable, Identifiable {
    case pace
    case overall

    static let storageKey = "providerQuota.widgetColorBasis"
    static let defaultValue = ProviderQuotaWidgetColorBasis.pace

    var id: String { rawValue }
    var title: String {
        switch self {
        case .pace: String(localized: "Pace")
        case .overall: String(localized: "Overall Percentage")
        }
    }
}

enum ProviderQuotaWidgetWindowSelection: String, AppEnum {
    case automatic
    case session
    case weekly

    static let storageKey = "providerQuota.widgetWindowSelection"
    static let defaultValue = ProviderQuotaWidgetWindowSelection.automatic

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota Window")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .automatic: "Automatic",
        .session: "Session",
        .weekly: "Weekly",
    ]
}

enum ProviderQuotaWidgetStatusText: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case percentage
    case pace
    case hidden

    static let storageKey = "providerQuota.widgetStatusText"
    static let defaultValue = ProviderQuotaWidgetStatusText.percentage
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Status Text")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .percentage: "Used or Remaining",
        .pace: "Pace",
        .hidden: "Hidden",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .percentage: String(localized: "Used or Remaining")
        case .pace: String(localized: "Pace")
        case .hidden: String(localized: "Hidden")
        }
    }
}

enum ProviderQuotaWidgetResetDisplay: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case hidden
    case compact
    case exact

    static let storageKey = "providerQuota.widgetResetDisplay"
    static let defaultValue = ProviderQuotaWidgetResetDisplay.compact
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Reset Display")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .hidden: "Hidden",
        .compact: "Compact Countdown",
        .exact: "Date and Time",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .hidden: String(localized: "Hidden")
        case .compact: String(localized: "Compact Countdown")
        case .exact: String(localized: "Date and Time")
        }
    }
}

enum ProviderQuotaWidgetTapAction: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case insights
    case settings
    case refresh
    case openApp
    case newChatWithProvider

    static let storageKey = "providerQuota.widgetTapAction"
    static let defaultValue = ProviderQuotaWidgetTapAction.insights
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Tap Action")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .insights: "Open Insights",
        .settings: "Open Widget Settings",
        .refresh: "Refresh in Talaria",
        .openApp: "Open Talaria",
        .newChatWithProvider: "New Chat with Provider",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .insights: String(localized: "Open Insights")
        case .settings: String(localized: "Open Widget Settings")
        case .refresh: String(localized: "Refresh in Talaria")
        case .openApp: String(localized: "Open Talaria")
        case .newChatWithProvider: String(localized: "New Chat with Provider")
        }
    }
}

enum ProviderQuotaWidgetBackground: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case system
    case clear
    case tinted
    case dark
    case light
    case custom

    static let storageKey = "providerQuota.widgetBackground"
    static let customColorHexKey = "providerQuota.widgetCustomBackgroundColorHex"
    static let opacityPercentKey = "providerQuota.widgetBackgroundOpacityPercent"
    static let defaultValue = ProviderQuotaWidgetBackground.system
    static let defaultCustomColorHex = "#1C1C1E"
    static let defaultOpacityPercent = 100
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Background")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .system: "System",
        .clear: "Transparent",
        .tinted: "Accent Tint",
        .dark: "Dark",
        .light: "Light",
        .custom: "Custom",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .system: String(localized: "System")
        case .clear: String(localized: "Transparent")
        case .tinted: String(localized: "Accent Tint")
        case .dark: String(localized: "Dark")
        case .light: String(localized: "Light")
        case .custom: String(localized: "Custom")
        }
    }
}

enum ProviderQuotaWidgetColorOverride: String, AppEnum {
    case appDefault
    case automatic
    case accent
    case blue
    case cyan
    case green
    case indigo
    case mint
    case orange
    case pink
    case purple
    case red
    case teal
    case yellow
    case brown
    case gray
    case custom

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Gauge Color")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .automatic: "Automatic",
        .accent: "Accent",
        .blue: "Blue",
        .cyan: "Cyan",
        .green: "Green",
        .indigo: "Indigo",
        .mint: "Mint",
        .orange: "Orange",
        .pink: "Pink",
        .purple: "Purple",
        .red: "Red",
        .teal: "Teal",
        .yellow: "Yellow",
        .brown: "Brown",
        .gray: "Gray",
        .custom: "Custom",
    ]

    func resolved(default value: ProviderQuotaWidgetArcColor) -> ProviderQuotaWidgetArcColor {
        self == .appDefault ? value : ProviderQuotaWidgetArcColor(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetWeightOverride: String, AppEnum {
    case appDefault
    case thin
    case regular
    case bold

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Gauge Weight")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .thin: "Thin",
        .regular: "Regular",
        .bold: "Bold",
    ]

    func resolved(default value: ProviderQuotaWidgetArcWeight) -> ProviderQuotaWidgetArcWeight {
        self == .appDefault ? value : ProviderQuotaWidgetArcWeight(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetBasisOverride: String, AppEnum {
    case appDefault
    case pace
    case overall

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Color Basis")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .pace: "Pace",
        .overall: "Overall Percentage",
    ]

    func resolved(default value: ProviderQuotaWidgetColorBasis) -> ProviderQuotaWidgetColorBasis {
        self == .appDefault ? value : ProviderQuotaWidgetColorBasis(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetPercentageOverride: String, AppEnum {
    case appDefault
    case used
    case remaining

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Percentage")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .used: "Used",
        .remaining: "Remaining",
    ]

    func resolved(default value: ProviderQuotaPercentageMode) -> ProviderQuotaPercentageMode {
        self == .appDefault ? value : ProviderQuotaPercentageMode(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetPaceMarkerOverride: String, AppEnum {
    case appDefault
    case shown
    case hidden

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Pace Marker")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .shown: "Shown",
        .hidden: "Hidden",
    ]

    func resolved(default value: Bool) -> Bool {
        switch self {
        case .appDefault: value
        case .shown: true
        case .hidden: false
        }
    }
}

enum ProviderQuotaWidgetAppearanceSettings {
    static let showsProviderIconKey = "providerQuota.widgetShowsProviderIcon"
    static let providerIconStyleKey = "providerQuota.widgetProviderIconStyle"
    static let healthyColorKey = "providerQuota.widgetHealthyColor"
    static let warningColorKey = "providerQuota.widgetWarningColor"
    static let criticalColorKey = "providerQuota.widgetCriticalColor"
    static let staleColorKey = "providerQuota.widgetStaleColor"
    static let unavailableColorKey = "providerQuota.widgetUnavailableColor"
    static let warningRemainingPercentKey = "providerQuota.widgetWarningRemainingPercent"
    static let criticalRemainingPercentKey = "providerQuota.widgetCriticalRemainingPercent"
    static let paceTolerancePercentKey = "providerQuota.widgetPaceTolerancePercent"
    static let paceWarningBurnRatePercentKey = "providerQuota.widgetPaceWarningBurnRatePercent"
    static let paceCriticalBurnRatePercentKey = "providerQuota.widgetPaceCriticalBurnRatePercent"
    static let paceMinimumElapsedHoursKey = "providerQuota.widgetPaceMinimumElapsedHours"
    static let showsPaceMarkerKey = "providerQuota.widgetShowsPaceMarker"
    static let trackColorKey = "providerQuota.widgetTrackColor"
    static let trackOpacityPercentKey = "providerQuota.widgetTrackOpacityPercent"
    static let customArcColorHexKey = "providerQuota.widgetCustomArcColorHex"
    static let customTrackColorHexKey = "providerQuota.widgetCustomTrackColorHex"
    static let customHealthyColorHexKey = "providerQuota.widgetCustomHealthyColorHex"
    static let customWarningColorHexKey = "providerQuota.widgetCustomWarningColorHex"
    static let customCriticalColorHexKey = "providerQuota.widgetCustomCriticalColorHex"
    static let customStaleColorHexKey = "providerQuota.widgetCustomStaleColorHex"
    static let customUnavailableColorHexKey = "providerQuota.widgetCustomUnavailableColorHex"

    static let defaultShowsProviderIcon = true
    static let defaultProviderIconStyle = ProviderIconStyle.color
    static let defaultHealthyColor = ProviderQuotaWidgetArcColor.accent
    static let defaultWarningColor = ProviderQuotaWidgetArcColor.orange
    static let defaultCriticalColor = ProviderQuotaWidgetArcColor.red
    static let defaultStaleColor = ProviderQuotaWidgetArcColor.orange
    static let defaultUnavailableColor = ProviderQuotaWidgetArcColor.orange
    static let defaultWarningRemainingPercent = 25
    static let defaultCriticalRemainingPercent = 10
    static let defaultPaceTolerancePercent = 3
    static let defaultPaceWarningBurnRatePercent = 125
    static let defaultPaceCriticalBurnRatePercent = 175
    static let defaultPaceMinimumElapsedHours = 12
    static let defaultShowsPaceMarker = true
    static let defaultTrackColor = ProviderQuotaWidgetArcColor.automatic
    static let defaultTrackOpacityPercent = 18
    static let defaultCustomArcColorHex = "#0A84FF"
    static let defaultCustomTrackColorHex = "#8E8E93"
    static let defaultCustomHealthyColorHex = "#0A84FF"
    static let defaultCustomWarningColorHex = "#FF9F0A"
    static let defaultCustomCriticalColorHex = "#FF453A"
    static let defaultCustomStaleColorHex = "#8E8E93"
    static let defaultCustomUnavailableColorHex = "#8E8E93"
}

enum ProviderQuotaLockScreenPaceDetail: String, CaseIterable, Identifiable {
    case burnAndForecast
    case burn
    case forecast

    static let defaultValue = ProviderQuotaLockScreenPaceDetail.burnAndForecast

    var id: String { rawValue }
    var title: String {
        switch self {
        case .burnAndForecast: String(localized: "Burn + Forecast")
        case .burn: String(localized: "Burn Rate")
        case .forecast: String(localized: "Forecast")
        }
    }
}

enum ProviderQuotaLockScreenSettings {
    static let showsProviderIconKey = "providerQuota.lockScreenShowsProviderIcon"
    static let showsResetKey = "providerQuota.lockScreenShowsReset"
    static let showsWindowKey = "providerQuota.lockScreenShowsWindow"
    static let paceDetailKey = "providerQuota.lockScreenPaceDetail"

    static let defaultShowsProviderIcon = true
    static let defaultShowsReset = true
    static let defaultShowsWindow = true
}

enum ProviderQuotaAlertSettings {
    static let isEnabledKey = "providerQuota.alertsEnabled"
    static let stateKey = "providerQuota.alertStates"
}

struct ProviderQuotaEvaluationSettings: Equatable {
    let percentageMode: ProviderQuotaPercentageMode
    let colorBasis: ProviderQuotaWidgetColorBasis
    let windowSelection: ProviderQuotaWidgetWindowSelection
    let warningRemainingPercent: Int
    let criticalRemainingPercent: Int
    let paceTolerancePercent: Int
    let paceWarningBurnRatePercent: Int
    let paceCriticalBurnRatePercent: Int
    let paceMinimumElapsedHours: Int

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
                : configuration?.windowSelection ?? .defaultValue,
            warningRemainingPercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey),
            criticalRemainingPercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey),
            paceTolerancePercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey),
            paceWarningBurnRatePercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey),
            paceCriticalBurnRatePercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey),
            paceMinimumElapsedHours: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey)
        )
    }
}

enum ProviderQuotaUrgency: Equatable {
    case healthy
    case warning
    case critical
    case stale
    case unavailable
}

struct ProviderQuotaPace: Equatable {
    let expectedRemainingPercent: Double
    let paceDeltaPercent: Double
    let burnRate: Double
    let minutesToReset: Double
    let projectedMinutesToEmpty: Double?
    let projectionEligible: Bool
}

struct ProviderQuotaPresentationState: Equatable {
    let window: ProviderQuotaWindow?
    let percent: Double?
    let remainingPercent: Double?
    let resetAt: Date?
    let referenceDate: Date
    let freshnessDate: Date
    let isStale: Bool
    let pace: ProviderQuotaPace?
    let urgency: ProviderQuotaUrgency
    let settings: ProviderQuotaEvaluationSettings

    var expectedPercent: Double? {
        guard let expectedRemaining = pace?.expectedRemainingPercent else { return nil }
        return settings.percentageMode == .used ? 100 - expectedRemaining : expectedRemaining
    }

    var modeLabel: String {
        settings.percentageMode == .used ? String(localized: "used") : String(localized: "remaining")
    }

    var paceLabel: String? {
        guard let delta = pace?.paceDeltaPercent else { return nil }
        let value = abs(delta).formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        if delta <= -Double(max(0, settings.paceTolerancePercent)) {
            return String(localized: "\(value) over pace")
        }
        if delta > 1 { return String(localized: "\(value) under pace") }
        return String(localized: "On pace")
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
            settings: settings
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

struct ProviderQuotaGaugeStyle {
    let arcColor: Color
    let trackColor: Color
    let lineWidth: Double
    let showsPaceMarker: Bool
    let showsProviderIcon: Bool
    let providerIconStyle: ProviderIconStyle
}


struct ProviderQuotaWidgetSlotLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let frames = ProviderQuotaWidgetSlotGeometry.frames(
            count: subviews.count,
            in: bounds,
            spacing: spacing
        )
        for (subview, frame) in zip(subviews, frames) {
            subview.place(
                at: CGPoint(x: frame.midX, y: frame.midY),
                anchor: .center,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }
}

struct ProviderQuotaWidgetPrimaryDetailLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        for (subview, frame) in zip(
            subviews,
            ProviderQuotaWidgetPrimaryDetailGeometry.frames(in: bounds, spacing: spacing)
        ) {
            subview.place(
                at: CGPoint(x: frame.midX, y: frame.midY),
                anchor: .center,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }
}

enum ProviderQuotaWidgetPrimaryDetailGeometry {
    static func frames(in bounds: CGRect, spacing: CGFloat) -> [CGRect] {
        let availableHeight = max(0, bounds.height - spacing)
        let primaryHeight = min(bounds.width, availableHeight * 0.6)
        return [
            CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: primaryHeight),
            CGRect(
                x: bounds.minX,
                y: bounds.minY + primaryHeight + spacing,
                width: bounds.width,
                height: max(0, availableHeight - primaryHeight)
            ),
        ]
    }
}

enum ProviderQuotaWidgetSlotGeometry {
    static func frames(count: Int, in bounds: CGRect, spacing: CGFloat) -> [CGRect] {
        guard count > 0 else { return [] }
        let columnCount = min(2, count)
        let rowCount = Int(ceil(Double(count) / Double(columnCount)))
        let cellWidth = max(0, (bounds.width - spacing * CGFloat(columnCount - 1)) / CGFloat(columnCount))
        let cellHeight = max(0, (bounds.height - spacing * CGFloat(rowCount - 1)) / CGFloat(rowCount))
        return (0..<count).map { index in
            let column = index % columnCount
            let row = index / columnCount
            return CGRect(
                x: bounds.minX + CGFloat(column) * (cellWidth + spacing),
                y: bounds.minY + CGFloat(row) * (cellHeight + spacing),
                width: cellWidth,
                height: cellHeight
            )
        }
    }
}

enum ProviderQuotaWidgetColorResolver {
    static func color(
        _ value: ProviderQuotaWidgetArcColor,
        customHex: String = ProviderQuotaWidgetAppearanceSettings.defaultCustomArcColorHex,
        automatic: Color = .accentColor
    ) -> Color {
        switch value {
        case .automatic: automatic
        case .accent: .accentColor
        case .blue: .blue
        case .cyan: .cyan
        case .green: .green
        case .indigo: .indigo
        case .mint: .mint
        case .orange: .orange
        case .pink: Color(red: 1.0, green: 0.40, blue: 0.72)
        case .purple: .purple
        case .red: .red
        case .teal: .teal
        case .yellow: .yellow
        case .brown: .brown
        case .gray: .gray
        case .custom: color(hex: customHex)
        }
    }

    static func color(hex: String, fallback: Color = .accentColor) -> Color {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return fallback }
        return Color(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

enum ProviderQuotaWidgetPalette {
    static func arcColor(
        urgency: ProviderQuotaUrgency,
        profile: ProviderQuotaWidgetResolvedProfile
    ) -> Color {
        let configured = ProviderQuotaWidgetArcColor(
            rawValue: profile.string(ProviderQuotaWidgetArcColor.storageKey)
        ) ?? .defaultValue
        guard configured == .automatic else {
            return ProviderQuotaWidgetColorResolver.color(
                configured,
                customHex: profile.string(ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey)
            )
        }
        let role: (String, ProviderQuotaWidgetArcColor, String) = switch urgency {
        case .healthy: (
            ProviderQuotaWidgetAppearanceSettings.healthyColorKey,
            .accent,
            ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey
        )
        case .warning: (
            ProviderQuotaWidgetAppearanceSettings.warningColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey
        )
        case .critical: (
            ProviderQuotaWidgetAppearanceSettings.criticalColorKey,
            .red,
            ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey
        )
        case .stale: (
            ProviderQuotaWidgetAppearanceSettings.staleColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey
        )
        case .unavailable: (
            ProviderQuotaWidgetAppearanceSettings.unavailableColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey
        )
        }
        return ProviderQuotaWidgetColorResolver.color(
            ProviderQuotaWidgetArcColor(rawValue: profile.string(role.0)) ?? role.1,
            customHex: profile.string(role.2)
        )
    }
}


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

enum ProviderQuotaDisplaySettings {
    static let aliasesKey = "providerQuota.providerAliases"

    static func aliases(from data: Data) -> [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    static func data(
        byRenaming providerID: String,
        to name: String,
        in data: Data
    ) -> Data {
        let providerID = providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !providerID.isEmpty else { return data }
        var aliases = aliases(from: data)
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            aliases.removeValue(forKey: providerID)
        } else {
            aliases[providerID] = String(name.prefix(64))
        }
        return (try? JSONEncoder().encode(aliases)) ?? data
    }

    static func displayName(
        providerID: String?,
        fallback: String,
        aliasesData: Data
    ) -> String {
        guard let providerID else { return fallback }
        return aliases(from: aliasesData)[providerID.lowercased()] ?? fallback
    }
}

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

enum ProviderQuotaDateParser {
    static func date(from value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return ISO8601DateFormatter().date(from: value) ?? fractional.date(from: value)
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
            from: source.windows,
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
        let pace = ProviderQuotaUrgencyCalculator.pace(
            for: window,
            referenceDate: referenceDate,
            minimumElapsedHours: settings.paceMinimumElapsedHours
        )
        let isStale = referenceDate.timeIntervalSince(source.freshnessDate) > ProviderQuotaWidgetSnapshot.staleAfter
        let urgency = ProviderQuotaUrgencyCalculator.urgency(
            windows: windowOverride.map { [$0] } ?? source.windows,
            status: source.status,
            isStale: isStale,
            referenceDate: referenceDate,
            basis: settings.colorBasis,
            warningRemainingPercent: settings.warningRemainingPercent,
            criticalRemainingPercent: settings.criticalRemainingPercent,
            paceTolerancePercent: settings.paceTolerancePercent,
            paceWarningBurnRatePercent: settings.paceWarningBurnRatePercent,
            paceCriticalBurnRatePercent: settings.paceCriticalBurnRatePercent,
            paceMinimumElapsedHours: settings.paceMinimumElapsedHours,
            windowSelection: windowOverride == nil ? settings.windowSelection : .automatic
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
            settings: settings
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
