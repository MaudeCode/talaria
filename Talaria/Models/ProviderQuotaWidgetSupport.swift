import AppIntents
import Foundation
import SwiftUI
import WidgetKit

struct ProviderQuotaWidgetSource: Codable, Equatable, Identifiable, Sendable {
    var id: String { sourceID }
    var freshnessDate: Date { ProviderQuotaDateParser.date(from: fetchedAt) ?? cachedAt }

    let sourceID: String
    let scopeID: String
    let scopeLabel: String
    let cachedAt: Date
    let providerID: String?
    let providerLabel: String
    let accountLabel: String
    let isActiveProvider: Bool
    let status: String
    let plan: String?
    let windows: [ProviderQuotaWindow]
    let quota: ProviderQuotaAmount?
    let retryAfter: String?
    let fetchedAt: String?

    init(
        sourceID: String,
        scopeID: String = "qscope_default",
        scopeLabel: String = "Default",
        cachedAt: Date = Date(),
        providerID: String? = nil,
        providerLabel: String,
        accountLabel: String,
        isActiveProvider: Bool,
        status: String,
        plan: String?,
        windows: [ProviderQuotaWindow],
        quota: ProviderQuotaAmount? = nil,
        retryAfter: String?,
        fetchedAt: String?
    ) {
        self.sourceID = sourceID
        self.scopeID = scopeID
        self.scopeLabel = scopeLabel
        self.cachedAt = cachedAt
        self.providerID = providerID
        self.providerLabel = providerLabel
        self.accountLabel = accountLabel
        self.isActiveProvider = isActiveProvider
        self.status = status
        self.plan = plan
        self.windows = windows
        self.quota = quota
        self.retryAfter = retryAfter
        self.fetchedAt = fetchedAt
    }

    init(_ source: ProviderQuotaSource, scopeID: String, scopeLabel: String) {
        self.init(
            sourceID: source.id,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            providerID: source.providerID,
            providerLabel: source.providerLabel,
            accountLabel: source.accountLabel,
            isActiveProvider: source.isActiveProvider,
            status: source.status,
            plan: source.plan,
            windows: source.windows,
            quota: source.quota,
            retryAfter: source.retryAfter,
            fetchedAt: source.fetchedAt
        )
    }

    func withCachedAt(_ cachedAt: Date) -> ProviderQuotaWidgetSource {
        ProviderQuotaWidgetSource(
            sourceID: sourceID,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            cachedAt: cachedAt,
            providerID: providerID,
            providerLabel: providerLabel,
            accountLabel: accountLabel,
            isActiveProvider: isActiveProvider,
            status: status,
            plan: plan,
            windows: windows,
            quota: quota,
            retryAfter: retryAfter,
            fetchedAt: fetchedAt
        )
    }
}

struct ProviderQuotaWidgetSnapshot: Codable, Equatable, Sendable {
    static let staleAfter: TimeInterval = 15 * 60

    let updatedAt: Date
    let sources: [ProviderQuotaWidgetSource]

    func isStale(at date: Date = Date(), maximumAge: TimeInterval = staleAfter) -> Bool {
        date.timeIntervalSince(updatedAt) > maximumAge
    }
}

struct ProviderQuotaWidgetSnapshotStore {
    static let widgetKind = "ProviderQuotaWidget"
    static let storageKey = "providerQuotaWidgetSnapshot.v1"

    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = UserDefaults(suiteName: Self.appGroupIdentifier)) {
        self.defaults = defaults
    }

    @discardableResult
    func save(
        scopeID: String,
        sources: [ProviderQuotaWidgetSource],
        updatedSourceIDs: Set<String>? = nil,
        at date: Date = Date()
    ) -> Bool {
        guard sources.allSatisfy({ $0.scopeID == scopeID }) else { return false }
        let previous = Dictionary(uniqueKeysWithValues: (load()?.sources ?? []).map { ($0.sourceID, $0) })
        let persistedSources = sources.map { source in
            guard let updatedSourceIDs,
                  !updatedSourceIDs.contains(source.sourceID),
                  let previous = previous[source.sourceID]
            else {
                return source
            }
            return source.withCachedAt(previous.cachedAt)
        }
        guard let defaults,
              let data = try? JSONEncoder().encode(
                ProviderQuotaWidgetSnapshot(updatedAt: date, sources: persistedSources)
              )
        else {
            return false
        }
        defaults.set(data, forKey: Self.storageKey)
        return true
    }

    func load() -> ProviderQuotaWidgetSnapshot? {
        guard let data = defaults?.data(forKey: Self.storageKey) else { return nil }
        return try? JSONDecoder().decode(ProviderQuotaWidgetSnapshot.self, from: data)
    }

    @discardableResult
    func clear() -> Bool {
        guard let defaults, defaults.object(forKey: Self.storageKey) != nil else { return false }
        defaults.removeObject(forKey: Self.storageKey)
        return true
    }

    static var appGroupIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "TalariaAppGroupIdentifier") as? String
            ?? "group.dev.kil.talaria"
    }

    static var appGroupDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }
}

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
        configuration: ProviderQuotaWidgetConfigurationIntent? = nil
    ) -> ProviderQuotaEvaluationSettings {
        let defaultPercentage = ProviderQuotaPercentageMode(
            rawValue: defaults.string(forKey: ProviderQuotaPercentageMode.storageKey) ?? ""
        ) ?? .defaultValue
        let defaultBasis = ProviderQuotaWidgetColorBasis(
            rawValue: defaults.string(forKey: ProviderQuotaWidgetColorBasis.storageKey) ?? ""
        ) ?? .defaultValue
        return ProviderQuotaEvaluationSettings(
            percentageMode: configuration?.percentageMode.resolved(default: defaultPercentage) ?? defaultPercentage,
            colorBasis: configuration?.colorBasis.resolved(default: defaultBasis) ?? defaultBasis,
            windowSelection: configuration?.windowSelection ?? .automatic,
            warningRemainingPercent: integer(defaults, ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey, ProviderQuotaWidgetAppearanceSettings.defaultWarningRemainingPercent),
            criticalRemainingPercent: integer(defaults, ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey, ProviderQuotaWidgetAppearanceSettings.defaultCriticalRemainingPercent),
            paceTolerancePercent: integer(defaults, ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey, ProviderQuotaWidgetAppearanceSettings.defaultPaceTolerancePercent),
            paceWarningBurnRatePercent: integer(defaults, ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey, ProviderQuotaWidgetAppearanceSettings.defaultPaceWarningBurnRatePercent),
            paceCriticalBurnRatePercent: integer(defaults, ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey, ProviderQuotaWidgetAppearanceSettings.defaultPaceCriticalBurnRatePercent),
            paceMinimumElapsedHours: integer(defaults, ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey, ProviderQuotaWidgetAppearanceSettings.defaultPaceMinimumElapsedHours)
        )
    }

    private static func integer(_ defaults: UserDefaults, _ key: String, _ fallback: Int) -> Int {
        defaults.object(forKey: key) == nil ? fallback : defaults.integer(forKey: key)
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

struct ProviderQuotaGaugeStyle {
    let arcColor: Color
    let trackColor: Color
    let lineWidth: Double
    let showsPaceMarker: Bool
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
        case .pink: .pink
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

struct ProviderQuotaGaugeView: View {
    let displayName: String
    let sourceStatus: String
    let state: ProviderQuotaPresentationState
    let statusText: ProviderQuotaWidgetStatusText
    let resetDisplay: ProviderQuotaWidgetResetDisplay
    let style: ProviderQuotaGaugeStyle
    let compact: Bool

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.125, to: 0.875)
                .stroke(baseTrackColor, style: arcStyle)
                .rotationEffect(.degrees(90))

            if let percent = state.percent {
                Circle()
                    .trim(from: 0.125, to: 0.125 + 0.75 * percent / 100)
                    .stroke(style.arcColor, style: arcStyle)
                    .rotationEffect(.degrees(90))
                    .widgetAccentable()
            }

            if style.showsPaceMarker, let expectedPercent = state.expectedPercent {
                paceMarker(expectedPercent: expectedPercent)
            }

            VStack(spacing: compact ? 1 : 3) {
                Text(displayName)
                    .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.68)
                    .multilineTextAlignment(.center)

                if let percent = state.percent {
                    Text(percent, format: .percent.scale(1).precision(.fractionLength(0...1)))
                        .font(compact ? .headline : .title2.bold())
                        .monospacedDigit()
                        .minimumScaleFactor(0.72)

                    if let secondaryLabel {
                        Text(secondaryLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                } else {
                    Text(ProviderQuotaPresentation.statusLabel(sourceStatus))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(compact ? 14 : 19)

            if state.percent != nil, let resetLabel {
                Text(resetLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .padding(.horizontal, compact ? 4 : 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var arcStyle: StrokeStyle {
        StrokeStyle(lineWidth: style.lineWidth, lineCap: .round)
    }

    private var baseTrackColor: Color {
        state.percent == nil ? style.arcColor.opacity(0.55) : style.trackColor
    }

    private var secondaryLabel: String? {
        switch statusText {
        case .hidden: nil
        case .appDefault, .percentage: state.modeLabel
        case .pace: state.paceLabel
        }
    }

    private var resetLabel: String? {
        guard resetDisplay != .hidden, let resetAt = state.resetAt else { return nil }
        if resetDisplay == .exact {
            return String(localized: "Resets \(resetAt.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
        }
        let minutes = max(0, Int(resetAt.timeIntervalSince(state.referenceDate) / 60))
        let days = minutes / (24 * 60)
        let hours = minutes % (24 * 60) / 60
        if days > 0 { return String(localized: "Resets \(days)d \(hours)h") }
        if hours > 0 { return String(localized: "Resets \(hours)h \(minutes % 60)m") }
        return String(localized: "Resets \(minutes)m")
    }

    private func paceMarker(expectedPercent: Double) -> some View {
        let position = 0.125 + 0.75 * min(max(expectedPercent, 0), 100) / 100
        let halfWidth = compact ? 0.004 : 0.003
        return Circle()
            .trim(from: max(0.125, position - halfWidth), to: min(0.875, position + halfWidth))
            .stroke(Color.primary, style: StrokeStyle(lineWidth: style.lineWidth + 1, lineCap: .butt))
            .rotationEffect(.degrees(90))
            .allowsHitTesting(false)
    }

    private var accessibilityLabel: String {
        guard let percent = state.percent else {
            return "\(displayName), \(ProviderQuotaPresentation.statusLabel(sourceStatus))"
        }
        let value = percent.formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        let stale = state.isStale ? String(localized: ", stale") : ""
        return "\(displayName), \(value) \(state.modeLabel)\(stale)"
    }
}

struct ProviderQuotaForecastView: View {
    let plan: String?
    let state: ProviderQuotaPresentationState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(state.window?.label ?? "Quota")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let plan, !plan.isEmpty {
                    Text(plan)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(.secondary.opacity(0.12), in: Capsule())
                }
            }

            if let resetAt = state.resetAt {
                Label {
                    Text(resetAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
                        .lineLimit(1)
                } icon: {
                    Image(systemName: "calendar.badge.clock")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                metric(title: "Burn", value: burnRateLabel)
                metric(title: budgetTitle, value: budgetLabel)
            }

            Label(forecastLabel, systemImage: forecastSystemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(forecastTint)
                .lineLimit(2)

            HStack(spacing: 5) {
                Image(systemName: state.isStale ? "clock.badge.exclamationmark" : "clock")
                Text("Updated \(state.freshnessDate, style: .relative)")
                    .lineLimit(1)
            }
            .font(.caption2)
            .foregroundStyle(state.isStale ? .orange : .secondary)
        }
        .minimumScaleFactor(0.7)
        .accessibilityElement(children: .combine)
    }

    private func metric(title: LocalizedStringKey, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold).monospacedDigit())
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private var burnRateLabel: String {
        guard let pace = state.pace else { return "—" }
        return "\(pace.burnRate.formatted(.number.precision(.fractionLength(2))))×"
    }

    private var budgetTitle: LocalizedStringKey {
        (state.pace?.minutesToReset ?? 0) >= 24 * 60 ? "Budget / day" : "Budget / hr"
    }

    private var budgetLabel: String {
        guard let pace = state.pace,
              let remaining = state.remainingPercent,
              pace.minutesToReset > 0
        else { return "—" }
        let divisor = pace.minutesToReset >= 24 * 60
            ? pace.minutesToReset / (24 * 60)
            : pace.minutesToReset / 60
        return (remaining / divisor).formatted(.percent.scale(1).precision(.fractionLength(0...1)))
    }

    private var forecastLabel: String {
        guard let pace = state.pace else { return String(localized: "Forecast unavailable") }
        guard let projected = pace.projectedMinutesToEmpty else {
            return String(localized: "No depletion projected")
        }
        let margin = projected - pace.minutesToReset
        if margin >= 0 { return String(localized: "Lasts through reset") }
        return String(localized: "Empty \(durationLabel(abs(margin))) early")
    }

    private var forecastSystemImage: String {
        guard let pace = state.pace, let projected = pace.projectedMinutesToEmpty else {
            return "checkmark.circle"
        }
        return projected >= pace.minutesToReset ? "checkmark.circle" : "exclamationmark.triangle"
    }

    private var forecastTint: Color {
        guard let pace = state.pace, let projected = pace.projectedMinutesToEmpty else { return .secondary }
        return projected >= pace.minutesToReset ? .green : .orange
    }

    private func durationLabel(_ minutes: Double) -> String {
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

struct ProviderQuotaSourceEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota source")
    static var defaultQuery = ProviderQuotaSourceEntityQuery()

    let id: String
    let name: String
    let scopeLabel: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(scopeLabel)")
    }

    init(source: ProviderQuotaWidgetSource, aliasesData: Data = Data()) {
        id = source.sourceID
        name = ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: aliasesData
        )
        scopeLabel = source.scopeLabel
    }
}

struct ProviderQuotaSourceEntityQuery: EnumerableEntityQuery {
    func entities(for identifiers: [ProviderQuotaSourceEntity.ID]) async throws -> [ProviderQuotaSourceEntity] {
        let wanted = Set(identifiers)
        return currentEntities(includeRemoved: true).filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaSourceEntity] {
        currentEntities(includeRemoved: false)
    }

    private func currentEntities(includeRemoved: Bool) -> [ProviderQuotaSourceEntity] {
        let aliasesData = ProviderQuotaWidgetSnapshotStore.appGroupDefaults.data(
            forKey: ProviderQuotaDisplaySettings.aliasesKey
        ) ?? Data()
        return (ProviderQuotaWidgetSnapshotStore().load()?.sources ?? [])
            .filter { includeRemoved || $0.status != "removed" }
            .map { ProviderQuotaSourceEntity(source: $0, aliasesData: aliasesData) }
    }
}

struct ProviderQuotaWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Provider quotas"
    static var description = IntentDescription("Choose the provider accounts shown in this widget.")

    @Parameter(title: "Source 1") var source1: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 2") var source2: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 3") var source3: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 4") var source4: ProviderQuotaSourceEntity?
    @Parameter(title: "Quota Window", default: .automatic) var windowSelection: ProviderQuotaWidgetWindowSelection
    @Parameter(title: "Percentage", default: .appDefault) var percentageMode: ProviderQuotaWidgetPercentageOverride
    @Parameter(title: "Status Text", default: .appDefault) var statusText: ProviderQuotaWidgetStatusText
    @Parameter(title: "Reset Display", default: .appDefault) var resetDisplay: ProviderQuotaWidgetResetDisplay
    @Parameter(title: "Color Basis", default: .appDefault) var colorBasis: ProviderQuotaWidgetBasisOverride
    @Parameter(title: "Gauge Color", default: .appDefault) var gaugeColor: ProviderQuotaWidgetColorOverride
    @Parameter(title: "Gauge Weight", default: .appDefault) var gaugeWeight: ProviderQuotaWidgetWeightOverride
    @Parameter(title: "Track Color", default: .appDefault) var trackColor: ProviderQuotaWidgetColorOverride
    @Parameter(title: "Pace Marker", default: .appDefault) var paceMarker: ProviderQuotaWidgetPaceMarkerOverride
    @Parameter(title: "Background", default: .appDefault) var background: ProviderQuotaWidgetBackground
    @Parameter(title: "Tap Action", default: .appDefault) var tapAction: ProviderQuotaWidgetTapAction

    static var parameterSummary: some ParameterSummary {
        Switch(.widgetFamily) {
            Case([.systemSmall, .accessoryInline, .accessoryCircular, .accessoryRectangular]) {
                Summary("Show \(\.$source1)") {
                    \.$windowSelection
                    \.$percentageMode
                    \.$statusText
                    \.$resetDisplay
                    \.$colorBasis
                    \.$gaugeColor
                    \.$gaugeWeight
                    \.$trackColor
                    \.$paceMarker
                    \.$background
                    \.$tapAction
                }
            }
            Case(.systemMedium) {
                Summary("Show \(\.$source1) and \(\.$source2)") {
                    \.$windowSelection
                    \.$percentageMode
                    \.$statusText
                    \.$resetDisplay
                    \.$colorBasis
                    \.$gaugeColor
                    \.$gaugeWeight
                    \.$trackColor
                    \.$paceMarker
                    \.$background
                    \.$tapAction
                }
            }
            DefaultCase {
                Summary("Show \(\.$source1), \(\.$source2), \(\.$source3), and \(\.$source4)") {
                    \.$windowSelection
                    \.$percentageMode
                    \.$statusText
                    \.$resetDisplay
                    \.$colorBasis
                    \.$gaugeColor
                    \.$gaugeWeight
                    \.$trackColor
                    \.$paceMarker
                    \.$background
                    \.$tapAction
                }
            }
        }
    }

    var sourceIDs: [String?] {
        [source1?.id, source2?.id, source3?.id, source4?.id]
    }
}
