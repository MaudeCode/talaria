import SwiftUI
import TalariaKit

struct UserProfileSettingsRow: View {
    let server: URL

    @AppStorage(SessionIdentitySettings.displayNameKey) private var displayName = ""
    @AppStorage(SessionIdentitySettings.initialsKey) private var initials = ""
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex

    var body: some View {
        HStack(spacing: 14) {
            Text(previewInitials)
                .font(.headline)
                .foregroundStyle(previewForeground)
                .frame(width: 48, height: 48)
                .background(previewColor, in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "User Profile" : displayName)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)

                Text(server.host ?? server.absoluteString)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var previewInitials: String {
        SessionIdentitySettings.displayInitials(
            displayName: displayName,
            storedInitials: initials,
            fallbackFullName: NSFullUserName()
        )
    }

    private var previewColor: Color {
        HeaderLogoColor.color(for: headerLogoColorHex)
    }

    private var previewForeground: Color {
        HeaderLogoColor.prefersDarkForeground(for: headerLogoColorHex) ? .black : .white
    }
}

struct UserProfileSettingsView: View {
    @Bindable var authManager: AuthManager

    @AppStorage(SessionIdentitySettings.displayNameKey) private var displayName = ""
    @AppStorage(SessionIdentitySettings.initialsKey) private var initials = ""
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex

    var body: some View {
        SettingsPage(title: String(localized: "User Profile")) {
            SettingsCard(title: String(localized: "User Profile")) {
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
            serversCard

            SettingsCard(title: String(localized: "Server Access")) {
                SettingsFootnote(signOutFootnote)

                SettingsButton(String(localized: "Sign Out of This Server"), role: .destructive) {
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

    private var serversCard: some View {
        SettingsCard(title: String(localized: "Servers")) {
            ForEach(authManager.servers) { account in
                if account.id != authManager.servers.first?.id {
                    SettingsDivider()
                }

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

            SettingsDivider()

            HapticButton {
                isPresentingAddServer = true
            } label: {
                SettingsAccessoryRow(title: String(localized: "Add Server"), systemImage: "plus.circle")
            }
            .buttonStyle(.plain)
            .accessibilityHint("Adds another Hermes server.")

            SettingsDivider()

            NavigationLink {
                CustomHeadersSettingsView(authManager: authManager)
            } label: {
                SettingsAccessoryRow(title: String(localized: "Connection Headers"), systemImage: "list.bullet.rectangle")
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

    let server: URL

    var body: some View {
        SettingsCategoryPage(category: .providers) {
            SettingsCard(title: String(localized: "Providers")) {
                NavigationLink {
                    ProvidersView(server: server)
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Providers"),
                        systemImage: "key.horizontal"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens provider rename and Insights visibility settings.")
            }

            SettingsCard(title: String(localized: "Quota Display")) {
                SettingsPickerRow(
                    title: String(localized: "Provider Icons"),
                    systemImage: "paintpalette",
                    selection: $providerIconStyle
                ) {
                    ForEach(ProviderIconStyle.allCases) { style in
                        Text(style.title).tag(style.rawValue)
                    }
                }

                SettingsDivider()

                SettingsPickerRow(
                    title: String(localized: "Quota Percentage"),
                    systemImage: "percent",
                    selection: $percentageMode
                ) {
                    ForEach(ProviderQuotaPercentageMode.allCases) { mode in
                        Text(mode.title).tag(mode.rawValue)
                    }
                }

                SettingsDivider()

                SettingsPickerRow(
                    title: String(localized: "Quota Refresh"),
                    systemImage: "arrow.clockwise",
                    selection: $refreshInterval
                ) {
                    ForEach(ProviderQuotaRefreshInterval.allCases) { interval in
                        Text(interval.title).tag(interval.rawValue)
                    }
                }

                SettingsFootnote(String(localized: "Controls refresh while Talaria is active. Background and widget refreshes request the same interval, but iOS controls when they run."))
            }
        }
        .onChange(of: percentageMode) {
            ProviderQuotaWidgetSnapshotStore.reloadTimelines()
        }
    }
}
