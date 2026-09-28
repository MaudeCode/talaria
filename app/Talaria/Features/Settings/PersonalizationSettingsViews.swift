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
            SettingsCard(title: String(localized: "Appearance")) {
                SettingsPickerRow(
                    title: String(localized: "Theme"),
                    systemImage: "circle.lefthalf.filled",
                    selection: $appThemeRawValue
                ) {
                    ForEach(AppTheme.allCases) { theme in
                        Text(theme.title).tag(theme.rawValue)
                    }
                }

                SettingsDivider()

                AccentColorSettings(
                    selectedHex: $headerLogoColorHex,
                    customColor: HeaderLogoColor.binding($headerLogoColorHex)
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Tint New Chat & Send"),
                    systemImage: "paintbrush.pointed",
                    isOn: $tintsPrimaryActions
                )

                SettingsFootnote(String(localized: "Apply your accent color to these primary buttons."))

                SettingsDivider()

                AppIconSettingsSection()
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
    }
}

struct NotificationsHapticsSettingsView: View {
    @Bindable var authManager: AuthManager

    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    var body: some View {
        SettingsCategoryPage(category: .notificationsAndHaptics) {
            SettingsCard(title: String(localized: "Alerts & Haptics")) {
                SettingsToggleRow(
                    title: String(localized: "Haptic Feedback"),
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: $isHapticsEnabled
                )

                SettingsDivider()

                NotificationPermissionToggle(kind: .responseCompletion)

                SettingsDivider()

                NotificationPermissionToggle(kind: .providerQuota)

                SettingsDivider()

                RelayNotificationSettingsRow(authManager: authManager)
            }
        }
    }
}

struct NotificationPermissionToggle: View {
    enum Kind {
        case responseCompletion
        case providerQuota

        var title: String {
            switch self {
            case .responseCompletion: String(localized: "Response Complete Alerts")
            case .providerQuota: String(localized: "Quota Pace Alerts")
            }
        }

        var systemImage: String {
            switch self {
            case .responseCompletion: "bell"
            case .providerQuota: "bell.badge"
            }
        }
    }

    let kind: Kind

    @State private var permissionStatus: UNAuthorizationStatus?
    @State private var statusMessage: String?
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var responseCompletionEnabled = false
    @AppStorage(ResponseCompletionNotifications.hasRequestedPermissionKey) private var hasRequestedPermission = false
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
