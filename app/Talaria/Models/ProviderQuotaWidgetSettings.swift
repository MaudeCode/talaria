import AppIntents
import Foundation
import TalariaKit
import SwiftUI
import WidgetKit

enum ProviderQuotaWidgetWindowSelection: String, AppEnum {
    case automatic
    case session
    case weekly

    static let storageKey = ProviderQuotaWidgetStorageKeys.windowSelection
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

    static let storageKey = ProviderQuotaWidgetStorageKeys.statusText
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

    static let storageKey = ProviderQuotaWidgetStorageKeys.resetDisplay
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

    static let storageKey = ProviderQuotaWidgetStorageKeys.tapAction
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

    static let storageKey = ProviderQuotaWidgetStorageKeys.background
    static let customColorHexKey = ProviderQuotaWidgetStorageKeys.backgroundCustomColorHex
    static let opacityPercentKey = ProviderQuotaWidgetStorageKeys.backgroundOpacityPercent
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
