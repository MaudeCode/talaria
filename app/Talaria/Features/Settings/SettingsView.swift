import SwiftUI
import TalariaKit

/// The category directory at the root of the Settings modal.
struct SettingsView: View {
    let server: URL
    var profileName: String?
    var serverName: String?
    @Binding var selection: SettingsPane?

    var body: some View {
        SidebarList {
            SectionSelectionRow(item: .userProfile, selection: $selection) {
                UserProfileSettingsRow(server: server)
            }
            .accessibilityIdentifier("settings-user-profile")

            SectionSelectionRow(item: .appleAccount, selection: $selection) {
                AppleAccountSettingsRow()
            }
            .accessibilityHint("Opens Apple account, iCloud sync, and Talaria Relay settings.")
            .accessibilityIdentifier("settings-apple-account")

            ForEach(SettingsCategory.Group.allCases) { group in
                SidebarSectionHeader(title: group.title) {
                    if let detail = groupDetail(group) {
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                ForEach(SettingsCategory.rootCategories.filter { $0.group == group }) { category in
                    SectionSelectionRow(item: .category(category), selection: $selection) {
                        Label {
                            Text(category.title)
                        } icon: {
                            Image(systemName: category.systemImage)
                                .foregroundStyle(.tint)
                        }
                    }
                    .accessibilityIdentifier("settings-category-\(category.id)")
                }
            }
        }
        .navigationTitle("Settings")
        .adaptiveSecondaryNavigationTitle(title: String(localized: "Settings"))
    }

    private func groupDetail(_ group: SettingsCategory.Group) -> String? {
        switch group {
        case .profile: profileName
        case .server: serverName?.isEmpty == false ? serverName : server.host ?? server.absoluteString
        case .interface, .device: nil
        }
    }
}

/// The page a Settings row opens.
struct SettingsPaneView: View {
    @Bindable var authManager: AuthManager
    let server: URL
    let pane: SettingsPane
    var onProfileChanged: () async -> Void = {}

    var body: some View {
        switch pane {
        case .userProfile:
            UserProfileSettingsView(authManager: authManager)
        case .appleAccount:
            AppleAccountSettingsView(authManager: authManager, server: server)
        case .providerQuotaWidget:
            ProviderQuotaWidgetAppearanceView()
        case .category(let category):
            categoryPage(category)
        }
    }

    @ViewBuilder
    private func categoryPage(_ category: SettingsCategory) -> some View {
        switch category {
        case .appearance:
            AppearanceSettingsView(authManager: authManager)
        case .notificationsAndHaptics:
            NotificationsHapticsSettingsView(authManager: authManager)
        case .navigation:
            NavigationSettingsView(server: server)
        case .speech:
            SpeechSettingsView()
        case .models:
            ModelsSettingsView(server: server)
        case .profiles:
            DefaultProfilePickerView(server: server, currentDefaultProfileName: nil) { _ in
                Task { await onProfileChanged() }
            }
        case .workspaces:
            WorkspaceManagerView(server: server, isPage: true, onRegistryChanged: {})
        case .system:
            SettingsCategoryPage(category: .system) {
                SettingsSection(title: String(localized: "System")) {
                    ServerUpdateSettingsSection(authManager: authManager, server: server)
                }
            }
        case .chats:
            ChatsSettingsView()
        case .liveActivitiesAndWidgets:
            LiveActivitiesWidgetsSettingsView()
        case .siriAndShortcuts:
            SiriShortcutsSettingsView()
        case .servers:
            ServersSettingsView(authManager: authManager)
        case .providers:
            ProvidersSettingsView(server: server)
        case .dataAndStorage:
            DataStorageSettingsView(server: server)
        case .about:
            AboutSettingsView(server: connectedServer)
                .id(connectedServer)
        case .developer:
            #if DEBUG
            DeveloperSettingsView()
            #else
            EmptyView()
            #endif
        }
    }

    private var connectedServer: URL? {
        guard case .loggedIn(let connected) = authManager.state, connected == server else { return nil }
        return connected
    }
}

#Preview {
    NavigationStack {
        SettingsView(server: URL(string: "https://webui.example.test")!, selection: .constant(nil))
    }
}
