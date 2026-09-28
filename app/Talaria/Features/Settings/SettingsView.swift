import SwiftUI
import TalariaKit

struct SettingsView: View {
    @Bindable var authManager: AuthManager
    let server: URL
    let initialScrollTarget: SettingsScrollAnchor?

    @State private var isPresentingInitialDestination: Bool

    init(authManager: AuthManager, server: URL, initialScrollTarget: SettingsScrollAnchor? = nil) {
        self.authManager = authManager
        self.server = server
        self.initialScrollTarget = initialScrollTarget
        _isPresentingInitialDestination = State(initialValue: initialScrollTarget != nil)
    }

    var body: some View {
        List {
            Section {
                NavigationLink {
                    UserProfileSettingsView(authManager: authManager)
                } label: {
                    UserProfileSettingsRow(server: server)
                }
                .accessibilityIdentifier("settings-user-profile")

                AppleAccountSettingsRow(authManager: authManager, server: server)
            }

            Section {
                ForEach(SettingsCategory.rootCategories) { category in
                    NavigationLink {
                        categoryDestination(category)
                    } label: {
                        Label(category.title, systemImage: category.systemImage)
                    }
                    .accessibilityIdentifier("settings-category-\(category.id)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationDestination(isPresented: $isPresentingInitialDestination) {
            if let initialScrollTarget {
                directDestination(initialScrollTarget.destination)
            }
        }
    }

    @ViewBuilder
    private func categoryDestination(_ category: SettingsCategory) -> some View {
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

    @ViewBuilder
    private func directDestination(_ destination: SettingsDestination) -> some View {
        switch destination {
        case .servers:
            ServersSettingsView(authManager: authManager, server: server)
        case .providerQuotas:
            ProvidersSettingsView(server: server)
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView(authManager: AuthManager(), server: URL(string: "https://webui.example.test")!)
    }
}
