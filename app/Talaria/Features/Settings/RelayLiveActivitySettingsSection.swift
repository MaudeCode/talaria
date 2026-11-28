import SwiftUI
import UIKit
import UserNotifications
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
    let services: NotificationSettingsServices
    let permissionStatus: UNAuthorizationStatus?
    let authorizationChanged: @MainActor (UNAuthorizationStatus) -> Void
    let completionAlertsEnabled: Bool
    @Binding var notificationsEnabled: Bool

    @State private var permissionRequestFailed = false
    @AppStorage(TalariaRelayNotifications.backgroundAlertsEnabledKey) private var backgroundAlertsEnabled = false

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

                SettingsFootnote(
                    permissionMessage
                        ?? (registrationID != nil
                            ? String(localized: "Delivered for servers connected to Talaria Relay.")
                            : String(localized: "Connect a server to Talaria Relay to enable remote alerts."))
                )
                if permissionStatus == .denied {
                    NotificationSettingsLink(setting: .notificationsApprovalInputAlerts)
                }

                RelayTestNotificationRow(
                    registrationID: registrationID, resolveCredentials: { relayCredentials },
                    isAuthorized: permissionStatus?.allowsSettingsToggleOn == true,
                    approvalInputAlertsEnabled: notificationsEnabled, completionAlertsEnabled: completionAlertsEnabled
                )
            }
            .id(registrationID)
        }
        .onChange(of: backgroundAlertsEnabled) {
            Task { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
        }
    }

    private var permissionMessage: String? {
        if permissionStatus == .denied {
            return String(localized: "Notifications are off in iOS Settings.")
        }
        if permissionRequestFailed, permissionStatus?.allowsSettingsToggleOn != true {
            return String(localized: "Notification permission is required for relay alerts.")
        }
        return nil
    }

    private var notificationBinding: Binding<Bool> {
        Binding(
            get: { notificationsEnabled },
            set: { enabled in
                if enabled {
                    Task { await enableNotifications() }
                } else {
                    notificationsEnabled = false
                    Task { await services.refreshRelay() }
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
        let status = await services.readAuthorization()
        let enabled = granted && status.allowsSettingsToggleOn
        notificationsEnabled = enabled
        permissionRequestFailed = !enabled
        authorizationChanged(status)
        if enabled {
            await TalariaAggregateLiveActivityManager.shared.refreshAfterNotificationPreferenceChange(registerForRemoteNotifications: true)
        }
    }
}

private struct RelayTestNotificationRow: View {
    let registrationID: String?
    let resolveCredentials: @MainActor () -> TalariaRelayCredentials?
    let isAuthorized: Bool
    let approvalInputAlertsEnabled: Bool
    let completionAlertsEnabled: Bool

    @AppStorage(TalariaRelayNotifications.pushTokenKey) private var pushToken: String?
    @AppStorage(TalariaRelayNotifications.updateAvailableAlertsEnabledKey) private var updateAlertsEnabled = false
    @AppStorage(TalariaRelayNotifications.unconfirmedUpdateAvailableAlertsKey) private var unconfirmedUpdateAlerts: Bool?
    @State private var state = State.idle

    private enum State: Equatable {
        case idle, sending, queued, failed(SettingsErrorText)
    }

    var body: some View {
        SettingsValueRow(
            title: SettingsIndex.notificationsTestNotification.title, systemImage: "bell",
            status: state == .queued ? String(localized: "Test notification queued.") : nil,
            hasInteractiveTrailingContent: true
        ) {
            SettingsButton(String(localized: "Send Test Notification"), systemImage: "paperplane", isLoading: state == .sending) {
                send()
            }
            .disabled(!canSend)
            .environment(\.settingsIndexPage, nil)
            .accessibilityIdentifier("send-relay-test-notification")
        } supplementary: {
            if case .failed(let error) = state {
                SettingsErrorFootnote(error)
            }
        }
    }

    private var canSend: Bool {
        registrationID != nil && isAuthorized && state != .sending && TalariaRelayNotifications.hasAlertsEnabled(
            pushToken: pushToken, approvalInput: approvalInputAlertsEnabled, completion: completionAlertsEnabled,
            updateAvailable: unconfirmedUpdateAlerts ?? updateAlertsEnabled
        )
    }

    private func send() {
        guard canSend, let credentials = resolveCredentials(), credentials.deviceRegistrationID == registrationID else { return }
        state = .sending
        Task {
            do {
                try await TalariaRelayClient(credentials: credentials).sendTestNotification()
                state = .queued
            } catch {
                state = .failed(Self.errorText(error))
            }
        }
    }

    private static func errorText(_ error: any Error) -> SettingsErrorText {
        let detail = (error as? TalariaRelayClient.ClientError)?.detail
        switch error {
        case TalariaRelayClient.ClientError.invalidResponse(404, _):
            return SettingsErrorText(String(localized: "Test notifications are unavailable."), detail: detail)
        case TalariaRelayClient.ClientError.invalidResponse(429, _):
            return SettingsErrorText(String(localized: "Wait before sending another test."), detail: detail)
        case let error as URLError:
            return SettingsErrorText(String(localized: "Couldn't reach Talaria Relay."), detail: "URLError \(error.code.rawValue)")
        default:
            return SettingsErrorText(error)
        }
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
