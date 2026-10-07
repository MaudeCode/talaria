import SwiftUI
import TalariaKit

/// The Settings root list. A row selects its page, which the section shows beside the list at
/// regular width and pushes at compact width (TAL-643).
struct SettingsView: View {
    let server: URL
    @Binding var selection: SectionItem?

    var body: some View {
        List {
            Section {
                SectionSelectionRow(item: .settings(.userProfile), selection: $selection) {
                    UserProfileSettingsRow(server: server)
                }
                .accessibilityIdentifier("settings-user-profile")

                SectionSelectionRow(item: .settings(.appleAccount), selection: $selection) {
                    AppleAccountSettingsRow()
                }
                .accessibilityHint("Opens Apple account, iCloud sync, and Talaria Relay settings.")
                .accessibilityIdentifier("settings-apple-account")
            }

            Section {
                ForEach(SettingsCategory.rootCategories) { category in
                    SectionSelectionRow(item: .settings(.category(category)), selection: $selection) {
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
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
    }
}

/// The page a Settings row opens.
struct SettingsPaneView: View {
    @Bindable var authManager: AuthManager
    let server: URL
    let pane: SettingsPane

    var body: some View {
        switch pane {
        case .userProfile:
            UserProfileSettingsView(authManager: authManager)
        case .appleAccount:
            AppleAccountSettingsView(authManager: authManager, server: server)
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
        case .chats:
            ChatsSettingsView(authManager: authManager, server: server)
        case .liveActivitiesAndWidgets:
            LiveActivitiesWidgetsSettingsView()
        case .siriAndShortcuts:
            SiriShortcutsSettingsView()
        case .servers:
            ServersSettingsView(authManager: authManager, server: server)
        case .providers:
            ProvidersSettingsView(server: server)
        case .dataAndStorage:
            DataStorageSettingsView(server: server)
        case .about:
            AboutSettingsView()
        case .developer:
            #if DEBUG
            DeveloperSettingsView()
            #else
            EmptyView()
            #endif
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView(server: URL(string: "https://webui.example.test")!, selection: .constant(nil))
    }
}
