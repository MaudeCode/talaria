import SwiftUI
import UIKit
import TalariaKit

struct RelayLiveActivitySettingsSection: View {
    @AppStorage(AgentRunLiveActivityPrivacy.showsResponseExcerptsKey)
    private var showsLiveActivityResponseExcerpts = false

    @AppStorage(TalariaLiveActivityMode.storageKey) private var modeRawValue = TalariaLiveActivityMode.perSession.rawValue

    var body: some View {
        SettingsSection(
            title: String(localized: "Live Activities"),
            help: String(localized: "Shows short response text on the Lock Screen and Dynamic Island.")
        ) {
            SettingsPickerRow(
                title: SettingsIndex.liveActivitiesAndWidgetsDisplay.title,
                systemImage: "bolt.horizontal.circle",
                selection: $modeRawValue
            ) {
                ForEach(TalariaLiveActivityMode.allCases) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            }

            SettingsToggleRow(
                title: SettingsIndex.liveActivitiesAndWidgetsLiveActivityExcerpts.title,
                systemImage: "lock",
                isOn: $showsLiveActivityResponseExcerpts
            )

            ServerSettingsSections(page: .liveActivity)
        }
        .onChange(of: modeRawValue) {
            Task {
                await AgentLiveActivityManager.shared.refreshForCurrentMode()
                try? await TalariaAggregateLiveActivityManager.shared.refresh()
            }
        }
    }
}

struct RelayNotificationSettingsRow: View {
    @Bindable var authManager: AuthManager

    @State private var statusMessage: String?
    @State private var isRelayAvailable = false
    @State private var updateAlertsOverride: Bool?
    @State private var updateAlertsWriteID: UUID?
    @State private var updateAlertsError: (message: SettingsErrorText, whileUnconfirmed: Bool)?
    @AppStorage(TalariaRelayNotifications.isEnabledKey) private var notificationsEnabled = false
    @AppStorage(TalariaRelayNotifications.backgroundAlertsEnabledKey) private var backgroundAlertsEnabled = false
    @AppStorage(TalariaRelayNotifications.updateAvailableAlertsEnabledKey) private var updateAlertsEnabled = false
    @AppStorage(TalariaRelayNotifications.unconfirmedUpdateAvailableAlertsKey) private var unconfirmedUpdateAlerts: Bool?
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var completionAlertsEnabled = false

    var body: some View {
        Group {
            SettingsToggleRow(
                title: SettingsIndex.notificationsApprovalInputAlerts.title,
                systemImage: "bell.badge",
                isOn: notificationBinding
            )
            .disabled(!isRelayAvailable)

            SettingsToggleRow(
                title: SettingsIndex.notificationsBackgroundAlerts.title,
                systemImage: "arrow.triangle.branch",
                isOn: $backgroundAlertsEnabled
            )
            .disabled(!isRelayAvailable || !completionAlertsEnabled)

            SettingsToggleRow(
                title: SettingsIndex.notificationsUpdateAvailable.title,
                systemImage: "arrow.down.circle",
                isOn: Binding(get: { updateAlertsOverride ?? unconfirmedUpdateAlerts ?? updateAlertsEnabled }, set: setUpdateAlerts),
                accessibilityIdentifier: SettingsIndex.notificationsUpdateAvailable.id
            )
            .disabled(!isRelayAvailable)

            if let updateAlertsError, !updateAlertsError.whileUnconfirmed || unconfirmedUpdateAlerts != nil {
                SettingsErrorFootnote(updateAlertsError.message)
            }

            SettingsFootnote(
                statusMessage
                    ?? (isRelayAvailable
                        ? String(localized: "Delivered for servers connected to Talaria Relay.")
                        : String(localized: "Connect a server to Talaria Relay to enable remote alerts."))
            )
        }
        .onChange(of: backgroundAlertsEnabled) {
            Task { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
        }
        .task { isRelayAvailable = relayCredentials != nil }
    }

    private var notificationBinding: Binding<Bool> {
        Binding(
            get: { notificationsEnabled },
            set: { enabled in
                if enabled {
                    Task { await enableNotifications() }
                } else {
                    notificationsEnabled = false
                    Task { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
                }
            }
        )
    }

    private var relayCredentials: TalariaRelayCredentials? {
        for account in authManager.servers {
            if let server = URL(string: account.urlString),
               let credentials = TalariaRelayConfigurationStore.operationalCredentials(for: server) {
                return credentials
            }
        }
        return nil
    }

    private func setUpdateAlerts(_ enabled: Bool) {
        let writeID = UUID()
        updateAlertsWriteID = writeID
        updateAlertsOverride = enabled
        updateAlertsError = nil
        Task {
            if enabled {
                let granted = await ResponseCompletionNotificationService.requestAuthorization()
                guard updateAlertsWriteID == writeID else { return }
                guard granted else {
                    updateAlertsOverride = nil
                    updateAlertsError = (SettingsErrorText(String(localized: "Notification permission is required for relay alerts.")), false)
                    return
                }
                UIApplication.shared.registerForRemoteNotifications()
            }
            guard updateAlertsWriteID == writeID else { return }
            guard let credentials = relayCredentials else {
                updateAlertsOverride = nil
                updateAlertsError = (SettingsErrorText(String(localized: "Connect a server to Talaria Relay to enable remote alerts.")), false)
                return
            }
            defer { if updateAlertsWriteID == writeID { updateAlertsOverride = nil } }
            do {
                try await TalariaRelayClient(credentials: credentials).configureDevice(
                    pushToStartEnabled: TalariaLiveActivityMode.current == .allRunning,
                    updateAvailableAlertsEnabled: enabled
                )
            } catch {
                guard updateAlertsWriteID == writeID else { return }
                let refused = (error as? TalariaRelayClient.ClientError)?.definitivelyRefusedWrite == true
                updateAlertsError = (SettingsErrorText(error), !refused)
            }
        }
    }

    @MainActor
    private func enableNotifications() async {
        guard isRelayAvailable else {
            notificationsEnabled = false
            return
        }
        let granted = await ResponseCompletionNotificationService.requestAuthorization()
        notificationsEnabled = granted
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
            statusMessage = nil
        } else {
            statusMessage = String(localized: "Notification permission is required for relay alerts.")
        }
        try? await TalariaAggregateLiveActivityManager.shared.refresh()
    }
}
