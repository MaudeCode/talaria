import AppIntents
import Foundation
import WidgetKit
import TalariaKit

struct ProviderQuotaWidgetSavedProfile: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    var values: [String: String]
}

enum ProviderQuotaWidgetProfileStore {
    static let defaultProfileID = "default"
    static let storageKey = "providerQuota.widgetProfiles.v1"
    static let selectedDefaultProfileKey = "providerQuota.widgetDefaultProfileID"

    static func profiles(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> [ProviderQuotaWidgetSavedProfile] {
        guard let data = defaults.data(forKey: storageKey) else { return [] }
        return ((try? JSONDecoder().decode([ProviderQuotaWidgetSavedProfile].self, from: data)) ?? [])
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    @discardableResult
    static func saveCurrent(
        name: String,
        id: String = UUID().uuidString,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> ProviderQuotaWidgetSavedProfile? {
        let name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(48))
        guard !name.isEmpty else { return nil }
        let profile = ProviderQuotaWidgetSavedProfile(id: id, name: name, values: currentValues(defaults: defaults))
        var profiles = profiles(defaults: defaults).filter { $0.id != id }
        profiles.append(profile)
        guard let data = try? JSONEncoder().encode(profiles) else { return nil }
        defaults.set(data, forKey: storageKey)
        return profile
    }

    static func delete(
        id: String,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) {
        guard id != defaultProfileID else { return }
        let remaining = profiles(defaults: defaults).filter { $0.id != id }
        defaults.set(try? JSONEncoder().encode(remaining), forKey: storageKey)
        if selectedDefaultProfileID(defaults: defaults) == id {
            defaults.removeObject(forKey: selectedDefaultProfileKey)
        }
    }

    static func selectedDefaultProfileID(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> String? {
        guard let id = defaults.string(forKey: selectedDefaultProfileKey),
              profiles(defaults: defaults).contains(where: { $0.id == id })
        else { return nil }
        return id
    }

    static func setDefault(
        id: String?,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) {
        guard let id,
              id != defaultProfileID,
              profiles(defaults: defaults).contains(where: { $0.id == id })
        else {
            defaults.removeObject(forKey: selectedDefaultProfileKey)
            return
        }
        defaults.set(id, forKey: selectedDefaultProfileKey)
    }

    static func apply(
        _ profile: ProviderQuotaWidgetSavedProfile,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) {
        let booleanKeys: Set<String> = [
            ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey,
            ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey,
        ]
        let integerKeys: Set<String> = [
            ProviderQuotaWidgetBackground.opacityPercentKey,
            ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey,
            ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey,
            ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey,
        ]
        for (key, value) in profile.values {
            if booleanKeys.contains(key) {
                defaults.set(["1", "true", "yes", "on"].contains(value.lowercased()), forKey: key)
            } else if integerKeys.contains(key), let integer = Int(value) {
                defaults.set(integer, forKey: key)
            } else {
                defaults.set(value, forKey: key)
            }
        }
    }

    static func profile(
        id: String?,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> ProviderQuotaWidgetSavedProfile? {
        guard let id, id != defaultProfileID else { return nil }
        return profiles(defaults: defaults).first { $0.id == id }
    }

    static func currentValues(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> [String: String] {
        var values = defaultValues
        for key in defaultValues.keys {
            guard let value = defaults.object(forKey: key) else { continue }
            if let string = value as? String {
                values[key] = string
            } else if let number = value as? NSNumber {
                values[key] = number.stringValue
            }
        }
        return values
    }

    static var defaultValues: [String: String] {
        [
            ProviderQuotaPercentageMode.storageKey: ProviderQuotaPercentageMode.defaultValue.rawValue,
            ProviderQuotaWidgetWindowSelection.storageKey: ProviderQuotaWidgetWindowSelection.defaultValue.rawValue,
            ProviderQuotaWidgetArcColor.storageKey: ProviderQuotaWidgetArcColor.defaultValue.rawValue,
            ProviderQuotaWidgetArcWeight.storageKey: ProviderQuotaWidgetArcWeight.defaultValue.rawValue,
            ProviderQuotaWidgetColorBasis.storageKey: ProviderQuotaWidgetColorBasis.defaultValue.rawValue,
            ProviderQuotaWidgetStatusText.storageKey: ProviderQuotaWidgetStatusText.defaultValue.rawValue,
            ProviderQuotaWidgetResetDisplay.storageKey: ProviderQuotaWidgetResetDisplay.defaultValue.rawValue,
            ProviderQuotaWidgetTapAction.storageKey: ProviderQuotaWidgetTapAction.defaultValue.rawValue,
            ProviderQuotaWidgetBackground.storageKey: ProviderQuotaWidgetBackground.defaultValue.rawValue,
            ProviderQuotaWidgetBackground.customColorHexKey: ProviderQuotaWidgetBackground.defaultCustomColorHex,
            ProviderQuotaWidgetBackground.opacityPercentKey: String(ProviderQuotaWidgetBackground.defaultOpacityPercent),
            ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey: String(ProviderQuotaWidgetAppearanceSettings.defaultShowsProviderIcon),
            ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey: ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle.rawValue,
            ProviderQuotaWidgetAppearanceSettings.healthyColorKey: ProviderQuotaWidgetAppearanceSettings.defaultHealthyColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.warningColorKey: ProviderQuotaWidgetAppearanceSettings.defaultWarningColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.criticalColorKey: ProviderQuotaWidgetAppearanceSettings.defaultCriticalColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.staleColorKey: ProviderQuotaWidgetAppearanceSettings.defaultStaleColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.unavailableColorKey: ProviderQuotaWidgetAppearanceSettings.defaultUnavailableColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultWarningRemainingPercent),
            ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultCriticalRemainingPercent),
            ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceTolerancePercent),
            ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceWarningBurnRatePercent),
            ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceCriticalBurnRatePercent),
            ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceMinimumElapsedHours),
            ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey: String(ProviderQuotaWidgetAppearanceSettings.defaultShowsPaceMarker),
            ProviderQuotaWidgetAppearanceSettings.trackColorKey: ProviderQuotaWidgetAppearanceSettings.defaultTrackColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultTrackOpacityPercent),
            ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomArcColorHex,
            ProviderQuotaWidgetAppearanceSettings.customTrackColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomTrackColorHex,
            ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomHealthyColorHex,
            ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomWarningColorHex,
            ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomCriticalColorHex,
            ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomStaleColorHex,
            ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomUnavailableColorHex,
        ]
    }
}

struct ProviderQuotaWidgetResolvedProfile {
    let id: String
    let name: String
    let values: [String: String]

    static func resolve(
        id: String?,
        followsSelectedDefault: Bool = true,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> ProviderQuotaWidgetResolvedProfile {
        let resolvedID = if (id == nil || id == ProviderQuotaWidgetProfileStore.defaultProfileID),
                            followsSelectedDefault {
            ProviderQuotaWidgetProfileStore.selectedDefaultProfileID(defaults: defaults)
        } else {
            id
        }
        if let profile = ProviderQuotaWidgetProfileStore.profile(id: resolvedID, defaults: defaults) {
            return ProviderQuotaWidgetResolvedProfile(id: profile.id, name: profile.name, values: profile.values)
        }
        return ProviderQuotaWidgetResolvedProfile(
            id: ProviderQuotaWidgetProfileStore.defaultProfileID,
            name: String(localized: "App Default"),
            values: ProviderQuotaWidgetProfileStore.currentValues(defaults: defaults)
        )
    }

    func string(_ key: String) -> String {
        values[key] ?? ProviderQuotaWidgetProfileStore.defaultValues[key] ?? ""
    }

    func integer(_ key: String) -> Int {
        Int(string(key)) ?? Int(ProviderQuotaWidgetProfileStore.defaultValues[key] ?? "") ?? 0
    }

    func boolean(_ key: String) -> Bool {
        ["1", "true", "yes", "on"].contains(string(key).lowercased())
    }
}

struct ProviderQuotaWidgetProfileEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Widget Profile")
    static var defaultQuery = ProviderQuotaWidgetProfileEntityQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ProviderQuotaWidgetProfileEntityQuery: EnumerableEntityQuery {
    func entities(for identifiers: [String]) async throws -> [ProviderQuotaWidgetProfileEntity] {
        let wanted = Set(identifiers)
        return allProfiles().filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaWidgetProfileEntity] { allProfiles() }

    func defaultResult() async -> ProviderQuotaWidgetProfileEntity? {
        let profiles = allProfiles()
        guard let selectedID = ProviderQuotaWidgetProfileStore.selectedDefaultProfileID() else {
            return profiles.first
        }
        return profiles.first { $0.id == selectedID } ?? profiles.first
    }

    private func allProfiles() -> [ProviderQuotaWidgetProfileEntity] {
        [ProviderQuotaWidgetProfileEntity(id: ProviderQuotaWidgetProfileStore.defaultProfileID, name: String(localized: "App Default"))]
            + ProviderQuotaWidgetProfileStore.profiles().map {
                ProviderQuotaWidgetProfileEntity(id: $0.id, name: $0.name)
            }
    }
}

struct ProviderQuotaSourceEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota source")
    static var defaultQuery = ProviderQuotaSourceEntityQuery()
    static let noneID = "talaria:none"
    static var none: ProviderQuotaSourceEntity {
        ProviderQuotaSourceEntity(
            id: noneID,
            name: String(localized: "None"),
            scopeLabel: String(localized: "Leave this slot empty")
        )
    }

    let id: String
    let name: String
    let scopeLabel: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(scopeLabel)")
    }

    init(id: String, name: String, scopeLabel: String) {
        self.id = id
        self.name = name
        self.scopeLabel = scopeLabel
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
        return ([ProviderQuotaSourceEntity.none] + Self.currentEntities(includeRemoved: true))
            .filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaSourceEntity] {
        [ProviderQuotaSourceEntity.none] + Self.currentEntities(includeRemoved: false)
    }

    func defaultResult() async -> ProviderQuotaSourceEntity? { ProviderQuotaSourceEntity.none }

    fileprivate static func currentEntities(includeRemoved: Bool) -> [ProviderQuotaSourceEntity] {
        let aliasesData = ProviderQuotaWidgetSnapshotStore.appGroupDefaults.data(
            forKey: ProviderQuotaDisplaySettings.aliasesKey
        ) ?? Data()
        return (ProviderQuotaWidgetSnapshotStore().load()?.sources ?? [])
            .filter { includeRemoved || $0.status != "removed" }
            .map { ProviderQuotaSourceEntity(source: $0, aliasesData: aliasesData) }
    }
}

struct ProviderQuotaPrimarySourceEntityQuery: EnumerableEntityQuery {
    func entities(for identifiers: [ProviderQuotaSourceEntity.ID]) async throws -> [ProviderQuotaSourceEntity] {
        let wanted = Set(identifiers)
        return ProviderQuotaSourceEntityQuery.currentEntities(includeRemoved: true)
            .filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaSourceEntity] {
        ProviderQuotaSourceEntityQuery.currentEntities(includeRemoved: false)
    }

    func defaultResult() async -> ProviderQuotaSourceEntity? {
        ProviderQuotaSourceEntityQuery.currentEntities(includeRemoved: false).first
    }
}

struct ProviderQuotaWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Provider quotas"
    static var description = IntentDescription("Choose the provider accounts shown in this widget.")

    @Parameter(title: "Source 1", query: ProviderQuotaPrimarySourceEntityQuery()) var source1: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 2", query: ProviderQuotaSourceEntityQuery()) var source2: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 3", query: ProviderQuotaSourceEntityQuery()) var source3: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 4", query: ProviderQuotaSourceEntityQuery()) var source4: ProviderQuotaSourceEntity?
    @Parameter(title: "Profile", query: ProviderQuotaWidgetProfileEntityQuery()) var profile: ProviderQuotaWidgetProfileEntity?
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
            Case(.systemSmall) {
                Summary("Show \(\.$source1)") {
                    \.$profile
                }
            }
            Case([.accessoryInline, .accessoryCircular, .accessoryRectangular]) {
                Summary("Show \(\.$source1)")
            }
            Case(.systemMedium) {
                Summary("Show \(\.$source1) and \(\.$source2)") {
                    \.$profile
                }
            }
            DefaultCase {
                Summary("Show \(\.$source1), \(\.$source2), \(\.$source3), and \(\.$source4)") {
                    \.$profile
                }
            }
        }
    }

    var sourceIDs: [String?] {
        [source1, source2, source3, source4].map { source in
            guard source?.id != ProviderQuotaSourceEntity.noneID else { return nil }
            return source?.id
        }
    }
}
