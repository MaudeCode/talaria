import Foundation
import UserNotifications
import TalariaKit

@MainActor
extension ProvidersViewModel {
    /// The App's model for `server`: quota alerts evaluate after each successful server response.
    static func app(server: URL) -> ProvidersViewModel {
        ProvidersViewModel(server: server, evaluateQuotaAlerts: { sources, freshIDs in
            Task { await ProviderQuotaAlertService.evaluate(sources, freshSourceIDs: freshIDs) }
        })
    }
}

/// Reads the widget presentation settings (`ProviderQuotaEvaluationSettings`, `ProviderQuotaPresentation`), which
/// the App and widget extension compile, so it stays in the App target.
extension ProviderQuotaAlertService {
    static func evaluate(_ sources: [ProviderQuotaWidgetSource], freshSourceIDs: Set<String>?) async {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: ProviderQuotaAlertSettings.isEnabledKey),
              await notificationsAreAllowed()
        else { return }

        let appGroup = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
        let settings = ProviderQuotaEvaluationSettings.stored(defaults: appGroup)
        let aliasesData = appGroup.data(forKey: ProviderQuotaDisplaySettings.aliasesKey) ?? Data()
        var previous = decodedStates(defaults.data(forKey: ProviderQuotaAlertSettings.stateKey))
        let currentSourceIDs = Set(sources.filter { $0.status != "removed" }.map(\.sourceID))
        previous = previous.filter { currentSourceIDs.contains($0.key) }

        let fresh = sources
            .filter { $0.status != "removed" && freshSourceIDs?.contains($0.sourceID) ?? true }
            .map { ($0, ProviderQuotaPresentation.state(for: $0, settings: settings, at: $0.freshnessDate)) }
        let preferences = Preferences.stored(defaults: defaults)
        let result = transitions(fresh.map { ($0.0.sourceID, $0.1.urgency) }, previous: previous, preferences: preferences)
        for (source, state) in fresh {
            guard let level = result.alerts[source.sourceID] else { continue }
            let name = ProviderQuotaDisplaySettings.displayName(
                providerID: source.providerID,
                fallback: source.providerLabel,
                aliasesData: aliasesData
            )
            let request = Self.request(
                level,
                sourceID: source.sourceID,
                name: name,
                remaining: state.remainingPercent,
                preferences: preferences
            )
            try? await UNUserNotificationCenter.current().add(request)
        }

        defaults.set(try? JSONEncoder().encode(result.states), forKey: ProviderQuotaAlertSettings.stateKey)
    }

    private static func notificationsAreAllowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private static func decodedStates(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }
}
