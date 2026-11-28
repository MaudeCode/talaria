import SwiftUI
import UIKit
import UserNotifications
import TalariaKit

struct NotificationSettingsServices: Sendable {
    let readAuthorization: @MainActor @Sendable () async -> UNAuthorizationStatus
    let refreshRelay: @MainActor @Sendable () async -> Void

    static let system = Self(
        readAuthorization: { await ResponseCompletionNotificationService.authorizationStatus() },
        refreshRelay: { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
    )
}

struct AppearanceSettingsView: View {
    @Bindable var authManager: AuthManager

    @AppStorage(AppTheme.storageKey) private var appThemeRawValue = AppTheme.system.rawValue
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex
    @AppStorage(PrimaryActionTintSettings.isEnabledKey) private var tintsPrimaryActions = false
    @AppStorage(SessionIdentitySettings.displayNameKey) private var identityDisplayName = ""
    @AppStorage(SessionIdentitySettings.initialsKey) private var identityInitials = ""

    var body: some View {
        SettingsCategoryPage(category: .appearance) {
            SettingsSection(title: String(localized: "Appearance")) {
                SettingsPickerRow(
                    title: SettingsIndex.appearanceTheme.title,
                    systemImage: "circle.lefthalf.filled",
                    selection: $appThemeRawValue
                ) {
                    ForEach(AppTheme.allCases) { theme in
                        Text(theme.title).tag(theme.rawValue)
                    }
                }

                AccentColorSettings(
                    selectedHex: $headerLogoColorHex,
                    customColor: HeaderLogoColor.binding($headerLogoColorHex)
                )

                SettingsToggleRow(
                    title: SettingsIndex.appearanceTintNewChatSend.title,
                    systemImage: "paintbrush.pointed",
                    isOn: $tintsPrimaryActions
                )

                AppIconSettingsSection()

                IdentitySaveErrorNotice(authManager: authManager)
            }

        }
        .onChange(of: headerLogoColorHex) {
            guard let account = authManager.servers.first(where: { $0.id == authManager.activeServerID }) else { return }
            authManager.updateServerIdentity(
                account,
                displayName: identityDisplayName,
                initials: identityInitials,
                headerLogoColorHex: headerLogoColorHex
            )
        }
        .onDisappear { authManager.flushServerIdentityEdits() }
    }
}

struct NotificationsHapticsSettingsView: View {
    @Bindable var authManager: AuthManager
    var services: NotificationSettingsServices = .system

    @Environment(\.scenePhase) private var scenePhase
    @State private var permissionStatus: UNAuthorizationStatus?
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var responseCompletionEnabled = false
    @AppStorage(ApprovalNotifications.isEnabledKey) private var approvalEnabled = false
    @AppStorage(ProviderQuotaAlertSettings.isEnabledKey) private var providerQuotaEnabled = false
    @AppStorage(TalariaRelayNotifications.isEnabledKey) private var relayAlertsEnabled = false

    var body: some View {
        SettingsCategoryPage(category: .notificationsAndHaptics) {
            SettingsSection(title: String(localized: "Alerts & Haptics")) {
                SettingsToggleRow(
                    title: SettingsIndex.notificationsHapticFeedback.title,
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: $isHapticsEnabled
                )

                permissionToggle(.responseCompletion, isEnabled: $responseCompletionEnabled)

                permissionToggle(.approval, isEnabled: $approvalEnabled)

                RelayNotificationSettingsRow(
                    authManager: authManager, services: services, permissionStatus: permissionStatus,
                    authorizationChanged: applyAuthorization, completionAlertsEnabled: responseCompletionEnabled,
                    notificationsEnabled: $relayAlertsEnabled
                )
            }

            SettingsSection(
                title: String(localized: "Provider Quotas"),
                help: String(localized: "Time Sensitive applies to critical quota alerts only.")
            ) {
                permissionToggle(.providerQuota, isEnabled: $providerQuotaEnabled)
                ProviderQuotaAlertLevelToggles()
            }
        }
        .task(id: scenePhase) {
            guard permissionStatus == nil || scenePhase == .active else { return }
            let status = await services.readAuthorization()
            guard !Task.isCancelled else { return }
            applyAuthorization(status)
        }
    }

    private func permissionToggle(_ kind: NotificationPermissionToggle.Kind, isEnabled: Binding<Bool>) -> some View {
        NotificationPermissionToggle(
            kind: kind, services: services, permissionStatus: permissionStatus,
            authorizationChanged: applyAuthorization, isEnabled: isEnabled
        )
    }

    private func applyAuthorization(_ status: UNAuthorizationStatus) {
        permissionStatus = status
        if status.disableUnavailableAlerts(
            completion: $responseCompletionEnabled, relay: $relayAlertsEnabled,
            local: [$approvalEnabled, $providerQuotaEnabled]
        ) {
            Task { await services.refreshRelay() }
        }
    }
}

/// Per-level quota alert controls; each is unavailable while the master quota switch or its parent level is off.
private struct ProviderQuotaAlertLevelToggles: View {
    @AppStorage(ProviderQuotaAlertSettings.isEnabledKey) private var isEnabled = false
    @AppStorage(ProviderQuotaAlertSettings.warningEnabledKey)
    private var warning = ProviderQuotaAlertSettings.defaultWarningEnabled
    @AppStorage(ProviderQuotaAlertSettings.criticalEnabledKey)
    private var critical = ProviderQuotaAlertSettings.defaultCriticalEnabled
    @AppStorage(ProviderQuotaAlertSettings.criticalTimeSensitiveKey)
    private var timeSensitive = ProviderQuotaAlertSettings.defaultCriticalTimeSensitive

    var body: some View {
        SettingsToggleRow(
            title: SettingsIndex.notificationsWarningAlerts.title,
            systemImage: "exclamationmark.triangle",
            isOn: $warning
        )
        .disabled(!isEnabled)

        SettingsToggleRow(
            title: SettingsIndex.notificationsCriticalAlerts.title,
            systemImage: "exclamationmark.octagon",
            isOn: $critical
        )
        .disabled(!isEnabled)

        SettingsToggleRow(
            title: SettingsIndex.notificationsTimeSensitive.title,
            systemImage: "clock.badge.exclamationmark",
            isOn: $timeSensitive
        )
        .disabled(!isEnabled || !critical)

    }
}

struct NotificationPermissionToggle: View {
    enum Kind {
        case responseCompletion
        case providerQuota
        case approval

        var setting: SettingsIndex {
            switch self {
            case .responseCompletion: .notificationsResponseCompleteAlerts
            case .providerQuota: .notificationsProviderQuotaAlerts
            case .approval: .notificationsApprovalAndQuestionAlerts
            }
        }

        var systemImage: String {
            switch self {
            case .responseCompletion: "bell"
            case .providerQuota: "bell.badge"
            case .approval: "checkmark.shield"
            }
        }
    }

    let kind: Kind
    let services: NotificationSettingsServices
    let permissionStatus: UNAuthorizationStatus?
    let authorizationChanged: @MainActor (UNAuthorizationStatus) -> Void
    @Binding var isEnabled: Bool

    @AppStorage(ResponseCompletionNotifications.hasRequestedPermissionKey) private var hasRequestedPermission = false

    var body: some View {
        Group {
            SettingsToggleRow(
                title: kind.setting.title,
                systemImage: kind.systemImage,
                isOn: Binding(get: { isEnabled }, set: { enabled in
                    if enabled {
                        Task { await enable() }
                    } else {
                        disable()
                    }
                })
            )

            if let permissionStatus {
                SettingsFootnote(permissionLabel(permissionStatus))
            }
            if permissionStatus == .denied {
                NotificationSettingsLink(setting: kind.setting)
            }
        }
    }

    private func disable() {
        isEnabled = false
        switch kind {
        case .responseCompletion:
            Task { await services.refreshRelay() }
        case .providerQuota:
            UserDefaults.standard.removeObject(forKey: ProviderQuotaAlertSettings.stateKey)
        case .approval:
            break
        }
    }

    @MainActor
    private func enable() async {
        guard await requestAccessIfAvailable() else { return }
        isEnabled = true
        switch kind {
        case .responseCompletion:
            await TalariaAggregateLiveActivityManager.shared.refreshAfterNotificationPreferenceChange(registerForRemoteNotifications: true)
        case .providerQuota:
            UserDefaults.standard.removeObject(forKey: ProviderQuotaAlertSettings.stateKey)
        case .approval:
            break
        }
    }

    @MainActor
    private func requestAccessIfAvailable() async -> Bool {
        let currentStatus = await services.readAuthorization()
        authorizationChanged(currentStatus)
        guard currentStatus == .notDetermined, !hasRequestedPermission else {
            return currentStatus.allowsSettingsToggleOn
        }
        hasRequestedPermission = true
        let granted = await ResponseCompletionNotificationService.requestAuthorization()
        let updatedStatus = await services.readAuthorization()
        authorizationChanged(updatedStatus)
        return granted && updatedStatus.allowsSettingsToggleOn
    }

    private func permissionLabel(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral:
            String(localized: "iOS notifications allowed.")
        case .notDetermined:
            String(localized: "iOS permission not requested.")
        case .denied:
            String(localized: "iOS notifications disabled.")
        @unknown default:
            String(localized: "Notifications unavailable.")
        }
    }
}

struct NotificationSettingsLink: View {
    let setting: SettingsIndex
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            let title = String(localized: "Open iOS Notification Settings")
            let identifier = "open-ios-notification-\(setting.id)"
            Button {
                UIApplication.shared.open(url)
            } label: {
                SettingsAccessoryRow(
                    title: title,
                    systemImage: dynamicTypeSize.isAccessibilitySize ? nil : "gearshape",
                    accessorySystemImage: dynamicTypeSize.isAccessibilitySize ? nil : "arrow.up.forward",
                    accessibilityIdentifier: identifier
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityIdentifier(identifier)
        }
    }
}

extension UNAuthorizationStatus {
    var allowsSettingsToggleOn: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral:
            true
        case .notDetermined, .denied:
            false
        @unknown default:
            false
        }
    }

    @MainActor
    func disableUnavailableAlerts(
        completion: Binding<Bool>, relay: Binding<Bool>, local: [Binding<Bool>]
    ) -> Bool {
        guard !allowsSettingsToggleOn else { return false }
        let relayRegistrationChanged = completion.wrappedValue || (self == .denied && relay.wrappedValue)
        for preference in [completion] + local where preference.wrappedValue {
            preference.wrappedValue = false
        }
        if self == .denied, relay.wrappedValue {
            relay.wrappedValue = false
        }
        return relayRegistrationChanged
    }
}
