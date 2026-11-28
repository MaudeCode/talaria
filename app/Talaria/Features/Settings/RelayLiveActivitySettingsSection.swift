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
    @AppStorage(TalariaRelayNotifications.isEnabledKey) private var notificationsEnabled = false
    @AppStorage(TalariaRelayNotifications.backgroundAlertsEnabledKey) private var backgroundAlertsEnabled = false
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var completionAlertsEnabled = false

    var body: some View {
        let registrationID = relayCredentials?.deviceRegistrationID
        Group {
            SettingsToggleRow(
                title: SettingsIndex.notificationsApprovalInputAlerts.title,
                systemImage: "bell.badge",
                isOn: notificationBinding
            )
            .disabled(registrationID == nil)

            SettingsToggleRow(
                title: SettingsIndex.notificationsBackgroundAlerts.title,
                systemImage: "arrow.triangle.branch",
                isOn: $backgroundAlertsEnabled
            )
            .disabled(registrationID == nil || !completionAlertsEnabled)

            Group {
                RelayRegistrationPreferenceToggle(
                    .sessionAlertSounds, registrationID: registrationID, resolveCredentials: { relayCredentials }
                )
                RelayRegistrationPreferenceToggle(
                    .updateAvailableAlerts, registrationID: registrationID, resolveCredentials: { relayCredentials }
                )
            }
            .id(registrationID)

            SettingsFootnote(
                statusMessage
                    ?? (registrationID != nil
                        ? String(localized: "Delivered for servers connected to Talaria Relay.")
                        : String(localized: "Connect a server to Talaria Relay to enable remote alerts."))
            )
        }
        .onChange(of: backgroundAlertsEnabled) {
            Task { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
        }
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

    @MainActor
    private func enableNotifications() async {
        guard relayCredentials != nil else {
            notificationsEnabled = false
            return
        }
        let granted = await ResponseCompletionNotificationService.requestAuthorization()
        notificationsEnabled = granted
        statusMessage = granted ? nil : String(localized: "Notification permission is required for relay alerts.")
        await TalariaAggregateLiveActivityManager.shared.refreshAfterNotificationPreferenceChange(registerForRemoteNotifications: granted)
    }
}

private struct RelayRegistrationPreferenceToggle: View {
    private let preference: TalariaRelayNotifications.RegistrationPreference
    private let registrationID: String?
    private let resolveCredentials: @MainActor () -> TalariaRelayCredentials?

    @AppStorage private var confirmed: Bool
    @AppStorage private var unconfirmed: Bool?
    @State private var override: Bool?
    @State private var writeID: UUID?
    @State private var writeError: (message: SettingsErrorText, whileUnconfirmed: Bool)?

    init(
        _ preference: TalariaRelayNotifications.RegistrationPreference,
        registrationID: String?,
        resolveCredentials: @MainActor @escaping () -> TalariaRelayCredentials?
    ) {
        self.preference = preference
        self.registrationID = registrationID
        self.resolveCredentials = resolveCredentials
        _confirmed = AppStorage(
            wrappedValue: preference.defaultValue, preference.confirmedKey(registrationID: registrationID)
        )
        _unconfirmed = AppStorage(preference.unconfirmedKey(registrationID: registrationID))
    }

    var body: some View {
        let setting: SettingsIndex = preference == .sessionAlertSounds
            ? .notificationsSessionAlertSounds : .notificationsUpdateAvailable
        SettingsToggleRow(
            title: setting.title,
            systemImage: preference == .sessionAlertSounds ? "speaker.wave.2" : "arrow.down.circle",
            isOn: Binding(get: { override ?? unconfirmed ?? confirmed }, set: setEnabled),
            accessibilityIdentifier: setting.id
        )
        .disabled(registrationID == nil)

        if let writeError, !writeError.whileUnconfirmed || unconfirmed != nil {
            SettingsErrorFootnote(writeError.message)
        }
    }

    private func currentCredentials() -> TalariaRelayCredentials? {
        guard let credentials = resolveCredentials(), credentials.deviceRegistrationID == registrationID else { return nil }
        return credentials
    }

    private func setEnabled(_ enabled: Bool) {
        let id = UUID()
        writeID = id
        override = enabled
        writeError = nil
        Task {
            defer { if writeID == id { override = nil } }
            // Sound only changes the delivery style. The alert switches own notification authorization.
            if preference == .updateAvailableAlerts, enabled {
                let granted = await ResponseCompletionNotificationService.requestAuthorization()
                guard writeID == id, currentCredentials() != nil else { return }
                guard granted else {
                    writeError = (SettingsErrorText(String(localized: "Notification permission is required for relay alerts.")), false)
                    return
                }
                UIApplication.shared.registerForRemoteNotifications()
            }
            guard writeID == id, let credentials = currentCredentials() else { return }
            do {
                try await TalariaRelayClient(credentials: credentials).configureDevice(
                    pushToStartEnabled: TalariaLiveActivityMode.current == .allRunning,
                    updateAvailableAlertsEnabled: preference == .updateAvailableAlerts ? enabled : nil,
                    notificationSoundEnabled: preference == .sessionAlertSounds ? enabled : nil,
                    whileCurrent: { currentCredentials() != nil }
                )
            } catch {
                guard writeID == id, currentCredentials() != nil else { return }
                let refused = (error as? TalariaRelayClient.ClientError)?.definitivelyRefusedWrite == true
                writeError = (SettingsErrorText(error), !refused)
            }
        }
    }
}
