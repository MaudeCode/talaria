import AuthenticationServices
import SwiftUI

/// The Settings-root account row for iCloud sync: the approved Sign in with
/// Apple action above the category directory.
struct ConfigurationSyncSettingsRow: View {
    @Bindable var authManager: AuthManager
    private var coordinator = ConfigurationSyncCoordinator.shared

    init(authManager: AuthManager) {
        self.authManager = authManager
    }

    var body: some View {
        NavigationLink {
            ConfigurationSyncSettingsView(authManager: authManager)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "icloud")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 40, height: 40)
                    .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("iCloud Sync")
                        .font(.body.weight(.semibold))
                    Text(coordinator.status.summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(minHeight: 48)
            .accessibilityElement(children: .combine)
        }
        .accessibilityHint("Opens iCloud sync for server setup and settings.")
        .accessibilityIdentifier("settings-icloud-sync")
    }
}

/// Account, sync, saved-password, and deletion controls for CloudKit sync.
/// Also presented from onboarding to restore an existing setup.
struct ConfigurationSyncSettingsView: View {
    @Bindable var authManager: AuthManager
    private var coordinator = ConfigurationSyncCoordinator.shared

    @Environment(\.colorScheme) private var colorScheme
    @State private var errorMessage: String?
    @State private var passwordAccount: ServerAccount?
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false

    init(authManager: AuthManager) {
        self.authManager = authManager
    }

    var body: some View {
        List {
            accountSection
            syncSection
            if coordinator.isSignedInWithApple, !authManager.servers.isEmpty {
                passwordsSection
            }
            if coordinator.isSignedInWithApple {
                deletionSection
            }
            if let errorMessage {
                Section {
                    SettingsErrorFootnote(errorMessage)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("iCloud Sync")
        .navigationBarTitleDisplayMode(.inline)
        .task { coordinator.adoptRelayIdentityIfNeeded() }
        .sheet(item: $passwordAccount) { account in
            ServerPasswordSheet(authManager: authManager, account: account)
        }
        .alert("Delete synced data?", isPresented: $isConfirmingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task { await deleteSyncedData() }
            }
        } message: {
            Text("This removes Talaria's synced servers, passwords, and settings from your iCloud account and turns sync off on this iPhone. Nothing on this iPhone is deleted.")
        }
    }

    private var isEnabledBinding: Binding<Bool> {
        Binding(
            get: { coordinator.isEnabled },
            set: { enabled in
                errorMessage = nil
                if enabled {
                    Task { await coordinator.enableSync() }
                } else {
                    coordinator.disableSync()
                }
            }
        )
    }

    private var accountSection: some View {
        Section {
            if coordinator.isSignedInWithApple {
                Label("Signed in with Apple", systemImage: "apple.logo")
                Button("Disconnect", role: .destructive) {
                    coordinator.disconnect()
                }
                .accessibilityIdentifier("settings-icloud-sync-disconnect")
            } else {
                SignInWithAppleButton(.continue) { request in
                    request.requestedScopes = []
                } onCompletion: { result in
                    handleAppleSignIn(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 46)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .accessibilityIdentifier("settings-icloud-sync-sign-in")
            }
        } header: {
            Text("Apple Account")
        } footer: {
            if coordinator.status == .appleCredentialRevoked {
                Text("Apple ID access was revoked, so sync stopped. Sign in again to resume.")
            } else if coordinator.isSignedInWithApple {
                Text("The same Apple account as Talaria Relay. Disconnecting stops sync and keeps every server and setting on this iPhone.")
            } else {
                Text("Connecting Talaria Relay signs in here too. Disconnecting stops sync and keeps every server and setting on this iPhone.")
            }
        }
    }

    private var syncSection: some View {
        Section {
            Toggle("Sync Server Setup & Settings", isOn: isEnabledBinding)
                .disabled(!coordinator.isSignedInWithApple)
                .accessibilityIdentifier("settings-icloud-sync-toggle")

            HStack(spacing: 10) {
                Image(systemName: coordinator.status.systemImage)
                    .foregroundStyle(coordinator.status.tint)
                Text(coordinator.status.summary)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if coordinator.status.isSyncing {
                    ProgressView()
                }
            }
            .font(.subheadline)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings-icloud-sync-status")

            Button("Sync Now") {
                errorMessage = nil
                Task { await coordinator.sync() }
            }
            .disabled(!coordinator.isEnabled || coordinator.status.isSyncing)
        } header: {
            Text("iCloud Sync")
        } footer: {
            Text("Server URLs, passwords, and custom headers are stored only as encrypted fields in your private iCloud database. CloudKit encrypts them on this device with keys from your iCloud Keychain. Session cookies and cached chats stay on this iPhone. The active server is chosen per device.")
        }
    }

    private var passwordsSection: some View {
        Section {
            ForEach(authManager.servers) { account in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.displayName.isEmpty ? account.urlString : account.displayName)
                            .lineLimit(1)
                        Text(URL(string: account.urlString)?.host ?? account.urlString)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 12)
                    if let password = authManager.serverPassword(for: account.id) {
                        Group {
                            if password.isEmpty {
                                Text("No password")
                            } else {
                                Text("Saved")
                            }
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    } else {
                        Button("Add Password") {
                            passwordAccount = account
                        }
                        .buttonStyle(.borderless)
                        .font(.subheadline.weight(.semibold))
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings-icloud-sync-password-\(account.id)")
            }
        } header: {
            Text("Server Passwords")
        } footer: {
            Text("A server is fully synced once its password is saved. Passwords are captured on sign-in, or add one here; it is checked against the server first.")
        }
    }

    private var deletionSection: some View {
        Section {
            Button("Delete Synced Data…", role: .destructive) {
                isConfirmingDelete = true
            }
            .disabled(isDeleting)
            .accessibilityIdentifier("settings-icloud-sync-delete")
        } footer: {
            Text("Removes Talaria's records from iCloud. Other iCloud data is not affected.")
        }
    }

    @MainActor
    private func handleAppleSignIn(_ result: Result<ASAuthorization, any Error>) {
        errorMessage = nil
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                errorMessage = String(localized: "Apple did not return an account.")
                return
            }
            coordinator.signInWithApple(userID: credential.user)
            Task { await coordinator.enableSync() }
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code != .canceled {
                errorMessage = error.localizedDescription
            }
        }
    }

    @MainActor
    private func deleteSyncedData() async {
        isDeleting = true
        errorMessage = nil
        defer { isDeleting = false }
        do {
            try await coordinator.deleteSyncedData()
        } catch {
            errorMessage = (error as? ConfigurationSyncStoreError)?.userMessage ?? error.localizedDescription
        }
    }
}

/// Captures a server's password for sync after verifying it with that server.
private struct ServerPasswordSheet: View {
    @Bindable var authManager: AuthManager
    let account: ServerAccount

    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Server password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .accessibilityIdentifier("settings-icloud-sync-password-field")
                } header: {
                    Text(account.displayName.isEmpty ? account.urlString : account.displayName)
                } footer: {
                    Text("Talaria signs in to check the password before saving it.")
                }
                if let errorMessage {
                    Section {
                        SettingsErrorFootnote(errorMessage)
                    }
                }
            }
            .navigationTitle("Add Password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(password.isEmpty)
                    }
                }
            }
        }
    }

    @MainActor
    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        if await authManager.verifyAndStorePassword(for: account, password: password) {
            dismiss()
        } else {
            errorMessage = authManager.lastErrorMessage
        }
    }
}

extension ConfigurationSyncStatus {
    var summary: String {
        switch self {
        case .signedOut:
            String(localized: "Sign in to sync servers and settings across your devices")
        case .appleCredentialRevoked:
            String(localized: "Apple ID access revoked. Sign in again.")
        case .disabled:
            String(localized: "Sync is off")
        case .unavailable(let reason):
            reason
        case .offline:
            String(localized: "Offline. Changes sync when you're back online.")
        case .syncing:
            String(localized: "Syncing…")
        case .failed(let message):
            message
        case .missingCredentials(let serverIDs):
            serverIDs.count == 1
                ? String(localized: "Add a password for 1 server to finish syncing")
                : String(localized: "Add passwords for \(serverIDs.count) servers to finish syncing")
        case .synced(let date):
            if let date {
                String(localized: "Synced \(date.formatted(.relative(presentation: .named)))")
            } else {
                String(localized: "Synced")
            }
        }
    }

    var systemImage: String {
        switch self {
        case .signedOut, .disabled: "icloud.slash"
        case .appleCredentialRevoked, .failed, .unavailable: "exclamationmark.icloud"
        case .offline: "wifi.slash"
        case .syncing: "arrow.triangle.2.circlepath.icloud"
        case .missingCredentials: "key.icloud"
        case .synced: "checkmark.icloud"
        }
    }

    var tint: Color {
        switch self {
        case .synced: .green
        case .appleCredentialRevoked, .failed, .unavailable: .orange
        default: .secondary
        }
    }
}
