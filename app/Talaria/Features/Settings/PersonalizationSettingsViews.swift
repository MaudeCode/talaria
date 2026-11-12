import SwiftUI
import UIKit
import UserNotifications
import TalariaKit

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

    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    var body: some View {
        SettingsCategoryPage(category: .notificationsAndHaptics) {
            SettingsSection(title: String(localized: "Alerts & Haptics")) {
                SettingsToggleRow(
                    title: SettingsIndex.notificationsHapticFeedback.title,
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: $isHapticsEnabled
                )

                NotificationPermissionToggle(kind: .responseCompletion)

                NotificationPermissionToggle(kind: .approval)

                RelayNotificationSettingsRow(authManager: authManager)
            }

            SettingsSection(
                title: String(localized: "Provider Quotas"),
                help: String(localized: "Time Sensitive applies to critical quota alerts only.")
            ) {
                NotificationPermissionToggle(kind: .providerQuota)
                ProviderQuotaAlertLevelToggles()
            }
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

        var title: String {
            switch self {
            case .responseCompletion: SettingsIndex.notificationsResponseCompleteAlerts.title
            case .providerQuota: SettingsIndex.notificationsProviderQuotaAlerts.title
            case .approval: SettingsIndex.notificationsApprovalAndQuestionAlerts.title
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

    @State private var permissionStatus: UNAuthorizationStatus?
    @State private var statusMessage: String?
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var responseCompletionEnabled = false
    @AppStorage(ResponseCompletionNotifications.hasRequestedPermissionKey) private var hasRequestedPermission = false
    @AppStorage(ApprovalNotifications.isEnabledKey) private var approvalEnabled = false
    @AppStorage(ProviderQuotaAlertSettings.isEnabledKey) private var providerQuotaEnabled = false

    var body: some View {
        Group {
            SettingsToggleRow(
                title: kind.title,
                systemImage: kind.systemImage,
                isOn: isEnabledBinding
            )

            if let statusText {
                SettingsFootnote(statusText)
            }
        }
        .task {
            await refreshPermissionStatus()
        }
    }

    private var isEnabledBinding: Binding<Bool> {
        Binding(
            get: {
                switch kind {
                case .responseCompletion: responseCompletionEnabled
                case .providerQuota: providerQuotaEnabled
                case .approval: approvalEnabled
                }
            },
            set: { enabled in
                if enabled {
                    Task { await enable() }
                } else {
                    disable()
                }
            }
        )
    }

    private var statusText: String? {
        statusMessage ?? permissionStatus.map(permissionLabel)
    }

    private func disable() {
        switch kind {
        case .responseCompletion:
            responseCompletionEnabled = false
            Task {
                await refreshPermissionStatus()
                try? await TalariaAggregateLiveActivityManager.shared.refresh()
            }
        case .approval:
            approvalEnabled = false
            Task { await refreshPermissionStatus() }
        case .providerQuota:
            providerQuotaEnabled = false
            UserDefaults.standard.removeObject(forKey: ProviderQuotaAlertSettings.stateKey)
            Task { await refreshPermissionStatus() }
        }
    }

    @MainActor
    private func enable() async {
        let enabled = await requestAccessIfAvailable()
        switch kind {
        case .responseCompletion:
            responseCompletionEnabled = enabled
            if enabled {
                UIApplication.shared.registerForRemoteNotifications()
            }
            try? await TalariaAggregateLiveActivityManager.shared.refresh()
        case .approval:
            approvalEnabled = enabled
        case .providerQuota:
            providerQuotaEnabled = enabled
            if enabled {
                UserDefaults.standard.removeObject(forKey: ProviderQuotaAlertSettings.stateKey)
            }
        }
    }

    @MainActor
    private func refreshPermissionStatus() async {
        let status = await ResponseCompletionNotificationService.authorizationStatus()
        permissionStatus = status
        if !status.allowsSettingsToggleOn {
            responseCompletionEnabled = false
            providerQuotaEnabled = false
            approvalEnabled = false
        }
        statusMessage = nil
    }

    @MainActor
    private func requestAccessIfAvailable() async -> Bool {
        let currentStatus = await ResponseCompletionNotificationService.authorizationStatus()
        permissionStatus = currentStatus

        switch currentStatus {
        case .authorized, .provisional, .ephemeral:
            statusMessage = nil
            return true
        case .notDetermined:
            guard !hasRequestedPermission else {
                statusMessage = String(localized: "Permission not requested.")
                return false
            }
            hasRequestedPermission = true
            let granted = await ResponseCompletionNotificationService.requestAuthorization()
            let updatedStatus = await ResponseCompletionNotificationService.authorizationStatus()
            permissionStatus = updatedStatus
            let enabled = granted && updatedStatus.allowsSettingsToggleOn
            statusMessage = enabled ? nil : permissionLabel(updatedStatus)
            return enabled
        case .denied:
            statusMessage = permissionLabel(currentStatus)
            return false
        @unknown default:
            statusMessage = String(localized: "Notifications unavailable.")
            return false
        }
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

private extension UNAuthorizationStatus {
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
}
