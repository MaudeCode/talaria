import SwiftUI
import UIKit
import TalariaKit

struct RelayLiveActivitySettingsCard: View {
    @AppStorage(TalariaLiveActivityMode.storageKey) private var modeRawValue = TalariaLiveActivityMode.perSession.rawValue

    var body: some View {
        SettingsCard(title: String(localized: "Live Activities")) {
            SettingsPickerRow(
                title: String(localized: "Display"),
                systemImage: "bolt.horizontal.circle",
                selection: $modeRawValue
            ) {
                ForEach(TalariaLiveActivityMode.allCases) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            }
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
    @AppStorage(TalariaRelayNotifications.isEnabledKey) private var notificationsEnabled = false

    var body: some View {
        Group {
            SettingsToggleRow(
                title: String(localized: "Approval & Input Alerts"),
                systemImage: "bell.badge",
                isOn: notificationBinding
            )
            .disabled(!isRelayAvailable)

            SettingsFootnote(
                statusMessage
                    ?? (isRelayAvailable
                        ? String(localized: "Delivered for servers connected to Talaria Relay.")
                        : String(localized: "Connect a server to Talaria Relay to enable remote alerts."))
            )
        }
        .task {
            isRelayAvailable = authManager.servers.contains { account in
                guard let server = URL(string: account.urlString) else { return false }
                return TalariaRelayConfigurationStore.operationalCredentials(for: server) != nil
            }
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
