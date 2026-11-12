import SwiftUI
import TalariaKit

struct UserProfileSettingsRow: View {
    let server: URL

    @AppStorage(SessionIdentitySettings.displayNameKey) private var displayName = ""
    @AppStorage(SessionIdentitySettings.initialsKey) private var initials = ""
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex

    var body: some View {
        SettingsItemRow(
            title: displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? String(localized: "User Profile") : displayName,
            subtitle: server.host ?? server.absoluteString
        ) {
            ServerAvatarBadge(initials: previewInitials, colorHex: headerLogoColorHex, size: 48, font: .headline)
        }
    }

    private var previewInitials: String {
        SessionIdentitySettings.displayInitials(
            displayName: displayName,
            storedInitials: initials,
            fallbackFullName: NSFullUserName()
        )
    }


}

struct UserProfileSettingsView: View {
    @Bindable var authManager: AuthManager

    @AppStorage(SessionIdentitySettings.displayNameKey) private var displayName = ""
    @AppStorage(SessionIdentitySettings.initialsKey) private var initials = ""
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex

    var body: some View {
        SettingsPage(title: String(localized: "User Profile"), indexPage: .userProfile) {
            SettingsSection(title: String(localized: "User Profile"), help: SettingsSectionHelp.identityMessage) {
                SessionIdentitySettingsEditor(
                    displayName: $displayName,
                    initials: initialsBinding,
                    previewInitials: previewInitials,
                    previewColor: HeaderLogoColor.color(for: headerLogoColorHex),
                    previewForeground: HeaderLogoColor.prefersDarkForeground(for: headerLogoColorHex) ? .black : .white
                )
            }
        }
        .onChange(of: displayName) { syncActiveServerIdentity() }
        .onChange(of: initials) { syncActiveServerIdentity() }
        .onChange(of: headerLogoColorHex) { syncActiveServerIdentity() }
        .onDisappear { authManager.flushServerIdentityEdits() }
        .identitySaveErrorInset(authManager)
    }

    private var initialsBinding: Binding<String> {
        Binding(
            get: { initials },
            set: { initials = SessionIdentitySettings.normalizedInitials($0) }
        )
    }

    private var previewInitials: String {
        SessionIdentitySettings.displayInitials(
            displayName: displayName,
            storedInitials: initials,
            fallbackFullName: NSFullUserName()
        )
    }

    private func syncActiveServerIdentity() {
        guard let account = authManager.servers.first(where: { $0.id == authManager.activeServerID }) else { return }
        authManager.updateServerIdentity(
            account,
            displayName: displayName,
            initials: initials,
            headerLogoColorHex: headerLogoColorHex
        )
    }
}

struct ServersSettingsView: View {
    @Bindable var authManager: AuthManager

    @State private var isPresentingAddServer = false
    @State private var isConfirmingSignOut = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SettingsCategoryPage(category: .servers) {
            serversSection

            SettingsSection(title: String(localized: "Server Access"), help: signOutFootnote) {
                SettingsButton(SettingsIndex.serversSignOutOfThisServer.title, role: .destructive) {
                    isConfirmingSignOut = true
                }
            }
        }
        .sheet(isPresented: $isPresentingAddServer) {
            AddServerView(authManager: authManager)
        }
        .alert("Sign out of this server?", isPresented: $isConfirmingSignOut) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out", role: .destructive) {
                Task {
                    await authManager.signOut()
                    dismiss()
                }
            }
        } message: {
            Text(signOutMessage)
        }
    }

    private var serversSection: some View {
        SettingsSection(title: SettingsIndex.serversList.title) {
            ForEach(authManager.servers) { account in

                NavigationLink {
                    ServerDetailView(authManager: authManager, account: account)
                } label: {
                    SettingsServerRow(
                        account: account,
                        isActive: account.id == authManager.activeServerID
                    )
                }
                .buttonStyle(.plain)
            }

            HapticButton {
                isPresentingAddServer = true
            } label: {
                SettingsAccessoryRow(title: SettingsIndex.serversAddServer.title, systemImage: "plus.circle")
            }
            .buttonStyle(.plain)
            .accessibilityHint("Adds another Hermes server.")

            NavigationLink {
                CustomHeadersSettingsView(authManager: authManager)
            } label: {
                SettingsAccessoryRow(title: SettingsIndex.serversConnectionHeaders.title, systemImage: "list.bullet.rectangle")
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the custom request headers editor.")

            IdentitySaveErrorNotice(authManager: authManager)
        }
    }

    private var signOutFootnote: String {
        authManager.servers.count > 1
            ? String(localized: "Signs out of the active server and switches to another configured server.")
            : String(localized: "Signs out of the active server and returns to onboarding.")
    }

    private var signOutMessage: String {
        authManager.servers.count > 1
            ? String(localized: "You'll switch to another configured server. Sign in again to use this one.")
            : String(localized: "You'll return to onboarding and need the server URL and password to sign back in.")
    }
}

struct ProvidersSettingsView: View {
    let server: URL

    var body: some View {
        SettingsCategoryPage(category: .providers) {
            SettingsSection(title: SettingsIndex.providersManageProviders.title) {
                NavigationLink {
                    ProvidersView(server: server)
                } label: {
                    SettingsAccessoryRow(
                        title: SettingsIndex.providersManageProviders.title,
                        systemImage: "key.horizontal"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens provider rename and Insights visibility settings.")
            }

            ProviderQuotaThresholdSettingsSections()
        }
    }
}

/// The former Providers quota-display section, kept together under Navigation with the other device preferences.
struct ProviderQuotaDisplaySettingsSection: View {
    @AppStorage(ProviderQuotaRefreshInterval.storageKey)
    private var refreshInterval = ProviderQuotaRefreshInterval.defaultValue.rawValue
    @AppStorage(
        ProviderQuotaPercentageMode.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var percentageMode = ProviderQuotaPercentageMode.defaultValue.rawValue
    @AppStorage(
        ProviderIconStyle.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerIconStyle = ProviderIconStyle.defaultValue.rawValue

    var body: some View {
        SettingsSection(
            title: String(localized: "Quota Display"),
            help: String(localized: """
            Controls refresh while Talaria is active. Background and widget refreshes request the same interval, \
            but iOS controls when they run.
            """)
        ) {
            SettingsPickerRow(
                title: SettingsIndex.navigationProviderIcons.title,
                systemImage: "paintpalette",
                selection: $providerIconStyle
            ) {
                ForEach(ProviderIconStyle.allCases) { style in
                    Text(style.title).tag(style.rawValue)
                }
            }

            SettingsPickerRow(
                title: SettingsIndex.navigationQuotaPercentage.title,
                systemImage: "percent",
                selection: $percentageMode
            ) {
                ForEach(ProviderQuotaPercentageMode.allCases) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            }

            SettingsPickerRow(
                title: SettingsIndex.navigationQuotaRefresh.title,
                systemImage: "arrow.clockwise",
                selection: $refreshInterval
            ) {
                ForEach(ProviderQuotaRefreshInterval.allCases) { interval in
                    Text(interval.title).tag(interval.rawValue)
                }
            }
        }
        .onChange(of: percentageMode) {
            ProviderQuotaWidgetSnapshotStore.reloadTimelines()
        }
    }
}
