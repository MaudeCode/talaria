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
    let server: URL

    @State private var isPresentingAddServer = false
    @State private var isConfirmingSignOut = false
    @State private var defaultModel: String?
    @State private var defaultProfileName: String?
    @State private var defaultProfileDisplayName: String?
    @State private var isLoadingDefaultModel = false
    @State private var isLoadingDefaultProfile = false
    @State private var showDefaultModelPicker = false
    @State private var showDefaultProfilePicker = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SettingsCategoryPage(category: .servers) {
            serversCard

            SettingsCard(title: String(localized: "Active Server")) {
                HapticButton {
                    showDefaultModelPicker = true
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Default Model"),
                        value: defaultModelLabel,
                        systemImage: "cpu"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the default model picker.")

                SettingsDivider()

                HapticButton {
                    showDefaultProfilePicker = true
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Default Profile"),
                        value: defaultProfileLabel,
                        systemImage: "person.crop.circle"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the default profile picker.")

                SettingsDivider()

                ServerUpdateSettingsSection(authManager: authManager, server: server)
            }

            SettingsCard(title: String(localized: "Server Access")) {
                SettingsFootnote(signOutFootnote)

                SettingsButton(String(localized: "Sign Out of This Server"), role: .destructive) {
                    isConfirmingSignOut = true
                }
            }
        }
        .task { await loadDefaults() }
        .refreshesLive(showsStatus: false) { await loadDefaults() }
        .sheet(isPresented: $isPresentingAddServer) {
            AddServerView(authManager: authManager)
        }
        .sheet(isPresented: $showDefaultModelPicker) {
            DefaultModelPickerView(
                server: server,
                currentDefaultModel: defaultModel,
                onSave: { defaultModel = $0 }
            )
        }
        .sheet(isPresented: $showDefaultProfilePicker) {
            DefaultProfilePickerView(
                server: server,
                currentDefaultProfileName: defaultProfileName,
                onSave: { selection in
                    defaultProfileName = selection.name
                    defaultProfileDisplayName = selection.displayName
                    if let model = selection.defaultModel, !model.isEmpty {
                        defaultModel = model
                    }
                }
            )
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
        }
    }

    private var defaultModelLabel: String {
        if isLoadingDefaultModel { return String(localized: "Loading") }
        guard let defaultModel, !defaultModel.isEmpty else { return String(localized: "Not set") }
        return defaultModel
    }

    private var defaultProfileLabel: String {
        if isLoadingDefaultProfile { return String(localized: "Loading") }
        if let defaultProfileDisplayName, !defaultProfileDisplayName.isEmpty {
            return defaultProfileDisplayName
        }
        guard let defaultProfileName, !defaultProfileName.isEmpty else { return String(localized: "Not set") }
        return defaultProfileName == "default" ? String(localized: "Default") : defaultProfileName
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

    @MainActor
    private func loadDefaults() async {
        let client = APIClient(baseURL: server)
        isLoadingDefaultModel = true
        isLoadingDefaultProfile = true

        do {
            defaultModel = try await client.models().defaultModel
        } catch {
            defaultModel = nil
        }
        isLoadingDefaultModel = false

        do {
            let profiles = try await client.profiles()
            defaultProfileName = profiles.effectiveDefaultProfileName
            defaultProfileDisplayName = profiles.displayName(for: defaultProfileName)
        } catch {
            defaultProfileName = nil
            defaultProfileDisplayName = nil
        }
        isLoadingDefaultProfile = false
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

                NavigationLink {
                    ProviderQuotaSidebarDisplayView()
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Sidebar Display"),
                        systemImage: "sidebar.left"
                    )
                }
                .buttonStyle(.plain)

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
