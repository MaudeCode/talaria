import Foundation

public enum ProviderIconStyle: String, CaseIterable, Identifiable {
    case color
    case silhouette

    public static let storageKey = "providerIcons.style"
    public static let defaultValue = ProviderIconStyle.color

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .color: String(localized: "Color")
        case .silhouette: String(localized: "Silhouette")
        }
    }
}

public enum ProviderQuotaDisplaySettings {
    public static let aliasesKey = "providerQuota.providerAliases"

    static func aliases(from data: Data) -> [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    public static func data(
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

    public static func displayName(
        providerID: String?,
        fallback: String,
        aliasesData: Data
    ) -> String {
        guard let providerID else { return fallback }
        return aliases(from: aliasesData)[providerID.lowercased()] ?? fallback
    }
}

public enum ProviderQuotaPercentageMode: String, CaseIterable, Identifiable {
    case used
    case remaining

    public static let storageKey = "providerQuota.percentageMode"
    public static let defaultValue = ProviderQuotaPercentageMode.used

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .used: String(localized: "Used")
        case .remaining: String(localized: "Remaining")
        }
    }
}

public enum ProviderQuotaWidgetArcColor: String, CaseIterable, Identifiable {
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

    public static let storageKey = "providerQuota.widgetArcColor"
    public static let defaultValue = ProviderQuotaWidgetArcColor.automatic

    public var id: String { rawValue }
    public var title: String {
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

public enum ProviderQuotaWidgetArcWeight: String, CaseIterable, Identifiable {
    case thin
    case regular
    case bold

    public static let storageKey = "providerQuota.widgetArcWeight"
    public static let defaultValue = ProviderQuotaWidgetArcWeight.regular

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .thin: String(localized: "Thin")
        case .regular: String(localized: "Regular")
        case .bold: String(localized: "Bold")
        }
    }
}

public enum ProviderQuotaWidgetColorBasis: String, CaseIterable, Identifiable {
    case pace
    case overall

    public static let storageKey = "providerQuota.widgetColorBasis"
    public static let defaultValue = ProviderQuotaWidgetColorBasis.pace

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .pace: String(localized: "Pace")
        case .overall: String(localized: "Overall Percentage")
        }
    }
}

public enum ProviderQuotaWidgetAppearanceSettings {
    public static let showsProviderIconKey = "providerQuota.widgetShowsProviderIcon"
    public static let providerIconStyleKey = "providerQuota.widgetProviderIconStyle"
    public static let healthyColorKey = "providerQuota.widgetHealthyColor"
    public static let warningColorKey = "providerQuota.widgetWarningColor"
    public static let criticalColorKey = "providerQuota.widgetCriticalColor"
    public static let staleColorKey = "providerQuota.widgetStaleColor"
    public static let unavailableColorKey = "providerQuota.widgetUnavailableColor"
    public static let warningRemainingPercentKey = "providerQuota.widgetWarningRemainingPercent"
    public static let criticalRemainingPercentKey = "providerQuota.widgetCriticalRemainingPercent"
    public static let paceTolerancePercentKey = "providerQuota.widgetPaceTolerancePercent"
    public static let paceWarningBurnRatePercentKey = "providerQuota.widgetPaceWarningBurnRatePercent"
    public static let paceCriticalBurnRatePercentKey = "providerQuota.widgetPaceCriticalBurnRatePercent"
    public static let paceMinimumElapsedHoursKey = "providerQuota.widgetPaceMinimumElapsedHours"
    public static let showsPaceMarkerKey = "providerQuota.widgetShowsPaceMarker"
    public static let trackColorKey = "providerQuota.widgetTrackColor"
    public static let trackOpacityPercentKey = "providerQuota.widgetTrackOpacityPercent"
    public static let customArcColorHexKey = "providerQuota.widgetCustomArcColorHex"
    public static let customTrackColorHexKey = "providerQuota.widgetCustomTrackColorHex"
    public static let customHealthyColorHexKey = "providerQuota.widgetCustomHealthyColorHex"
    public static let customWarningColorHexKey = "providerQuota.widgetCustomWarningColorHex"
    public static let customCriticalColorHexKey = "providerQuota.widgetCustomCriticalColorHex"
    public static let customStaleColorHexKey = "providerQuota.widgetCustomStaleColorHex"
    public static let customUnavailableColorHexKey = "providerQuota.widgetCustomUnavailableColorHex"

    public static let defaultShowsProviderIcon = true
    public static let defaultProviderIconStyle = ProviderIconStyle.color
    public static let defaultHealthyColor = ProviderQuotaWidgetArcColor.accent
    public static let defaultWarningColor = ProviderQuotaWidgetArcColor.orange
    public static let defaultCriticalColor = ProviderQuotaWidgetArcColor.red
    public static let defaultStaleColor = ProviderQuotaWidgetArcColor.orange
    public static let defaultUnavailableColor = ProviderQuotaWidgetArcColor.orange
    public static let defaultWarningRemainingPercent = 25
    public static let defaultCriticalRemainingPercent = 10
    public static let defaultPaceTolerancePercent = 3
    public static let defaultPaceWarningBurnRatePercent = 125
    public static let defaultPaceCriticalBurnRatePercent = 175
    public static let defaultPaceMinimumElapsedHours = 12
    public static let defaultShowsPaceMarker = true
    public static let defaultTrackColor = ProviderQuotaWidgetArcColor.automatic
    public static let defaultTrackOpacityPercent = 18
    public static let defaultCustomArcColorHex = "#0A84FF"
    public static let defaultCustomTrackColorHex = "#8E8E93"
    public static let defaultCustomHealthyColorHex = "#0A84FF"
    public static let defaultCustomWarningColorHex = "#FF9F0A"
    public static let defaultCustomCriticalColorHex = "#FF453A"
    public static let defaultCustomStaleColorHex = "#8E8E93"
    public static let defaultCustomUnavailableColorHex = "#8E8E93"
}

public enum ProviderQuotaLockScreenPaceDetail: String, CaseIterable, Identifiable {
    case burnAndForecast
    case burn
    case forecast

    public static let defaultValue = ProviderQuotaLockScreenPaceDetail.burnAndForecast

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .burnAndForecast: String(localized: "Burn + Forecast")
        case .burn: String(localized: "Burn Rate")
        case .forecast: String(localized: "Forecast")
        }
    }
}

public enum ProviderQuotaLockScreenSettings {
    public static let showsProviderIconKey = "providerQuota.lockScreenShowsProviderIcon"
    public static let showsResetKey = "providerQuota.lockScreenShowsReset"
    public static let showsWindowKey = "providerQuota.lockScreenShowsWindow"
    public static let paceDetailKey = "providerQuota.lockScreenPaceDetail"

    public static let defaultShowsProviderIcon = true
    public static let defaultShowsReset = true
    public static let defaultShowsWindow = true
}

public enum ProviderQuotaAlertSettings {
    public static let isEnabledKey = "providerQuota.alertsEnabled"
    public static let stateKey = "providerQuota.alertStates"
}
