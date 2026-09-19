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
