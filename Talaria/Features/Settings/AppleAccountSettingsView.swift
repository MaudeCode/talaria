import AuthenticationServices
import SwiftUI

/// The one account row above the Settings category directory: Sign in with
/// Apple for both iCloud Sync (TAL-91) and Talaria Relay (TAL-97).
struct AppleAccountSettingsRow: View {
    @Bindable var authManager: AuthManager
    let server: URL
    private var coordinator = ConfigurationSyncCoordinator.shared

    init(authManager: AuthManager, server: URL) {
        self.authManager = authManager
        self.server = server
    }

    var body: some View {
        NavigationLink {
            AppleAccountSettingsView(authManager: authManager, server: server)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "apple.logo")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 40, height: 40)
                    .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Apple Account")
                        .font(.body.weight(.semibold))
                    Group {
                        if coordinator.isSignedInWithApple {
                            Text(coordinator.status.summary)
                        } else {
                            Text("Sign in for iCloud sync, remote Live Activities, and alerts")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(minHeight: 48)
            .accessibilityElement(children: .combine)
        }
        .task { coordinator.adoptRelayIdentityIfNeeded() }
        .accessibilityHint("Opens Apple account, iCloud sync, and Talaria Relay settings.")
        .accessibilityIdentifier("settings-apple-account")
    }
}

/// One Sign in with Apple for everything Apple-backed: iCloud Sync of servers
/// and settings, and Talaria Relay for remote Live Activities and alerts.
/// Also presented from onboarding to restore an existing setup.
struct AppleAccountSettingsView: View {
    @Bindable var authManager: AuthManager
    let server: URL?
    private var coordinator = ConfigurationSyncCoordinator.shared

    @Environment(\.colorScheme) private var colorScheme
    @State private var appleNonce = TalariaRelayClient.makeAppleNonce()
    @State private var relayCredentials: TalariaRelayCredentials?
    @State private var relayAuthorized = false
    @State private var isConnectingRelay = false
    @State private var isConfirmingDisconnect = false
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false
    @State private var passwordAccount: ServerAccount?
    @State private var errorMessage: String?

    init(authManager: AuthManager, server: URL?) {
        self.authManager = authManager
        self.server = server
    }

    var body: some View {
        List {
            accountSection
            syncSection
            if coordinator.isSignedInWithApple {
                relaySection
                if !serversMissingPassword.isEmpty {
                    passwordsSection
                }
                dangerSection
            }
            if let errorMessage {
                Section {
                    SettingsErrorFootnote(errorMessage)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Apple Account")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            coordinator.adoptRelayIdentityIfNeeded()
            await loadRelayState()
        }
        .sheet(item: $passwordAccount) { account in
            ServerPasswordSheet(authManager: authManager, account: account)
        }
        .alert("Disconnect Apple account?", isPresented: $isConfirmingDisconnect) {
            Button("Cancel", role: .cancel) {}
            Button("Disconnect", role: .destructive) {
                Task { await disconnect() }
            }
        } message: {
            Text("This stops iCloud sync and signs this iPhone out of Talaria Relay. Your servers and settings stay on this iPhone.")
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

    // MARK: - Sections

    private var relayState: TalariaRelayConnectionState {
        guard let server, relayCredentials == nil || relayAuthorized else {
            return relayCredentials == nil ? .signedOut : .expired
        }
        return TalariaRelayConfigurationStore.connectionState(for: server, credentials: relayCredentials)
    }

    private var needsAppleSignIn: Bool {
        if !coordinator.isSignedInWithApple { return true }
        switch relayState {
        case .signedOut, .expired, .disconnectPending: return server != nil
        case .unpaired, .connected: return false
        }
    }

    private var accountSection: some View {
        Section {
            if coordinator.isSignedInWithApple {
                Label("Signed in with Apple", systemImage: "checkmark.circle.fill")
            }
            if needsAppleSignIn {
                SignInWithAppleButton(.continue) { request in
                    request.nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
                } onCompletion: { result in
                    handleAppleSignIn(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 46)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .disabled(isConnectingRelay)
                .accessibilityIdentifier("settings-sign-in-with-apple")
            }
        } header: {
            Text("Apple Account")
        } footer: {
            if coordinator.status == .appleCredentialRevoked {
                Text("Apple ID access was revoked, so sync and relay alerts stopped. Sign in again to resume.")
            } else if coordinator.isSignedInWithApple, relayState == .expired {
                Text("Talaria Relay needs a fresh sign-in. iCloud sync keeps working.")
            } else {
                Text("One sign-in covers iCloud sync of your servers and settings and Talaria Relay for remote Live Activities and alerts.")
            }
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

    private var syncSection: some View {
        Section {
            Toggle("Sync Servers & Settings", isOn: isEnabledBinding)
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

    private var relaySection: some View {
        Section {
            if server != nil, relayState == .unpaired || relayState == .connected {
                NavigationLink {
                    RelayConnectionManagementView(authManager: authManager)
                } label: {
                    relaySummary
                }
                .accessibilityHint("Opens Talaria Relay connection management.")
                .accessibilityIdentifier("settings-manage-relay")
            } else {
                relaySummary
            }
        } header: {
            Text("Talaria Relay")
        } footer: {
            Text("Delivers Live Activities and alerts for connected servers even when Talaria is closed.")
        }
    }

    private var relaySummary: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Talaria Relay")
                    .font(.body)
                Text(relaySummaryText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if isConnectingRelay {
                ProgressView()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var relaySummaryText: String {
        if isConnectingRelay { return String(localized: "Connecting…") }
        switch relayState {
        case .connected: return String(localized: "Connected to \(activeServerName)")
        case .unpaired: return String(localized: "Connect \(activeServerName)")
        case .signedOut: return String(localized: "Sign in to connect this server")
        case .expired, .disconnectPending: return relayState.title
        }
    }

    private var activeServerName: String {
        authManager.servers.first(where: { $0.id == authManager.activeServerID })?.displayName
            ?? server?.host
            ?? server?.absoluteString
            ?? ""
    }

    /// Servers whose password could not be worked out automatically: a
    /// password-only server signed in before passwords were retained.
    private var serversMissingPassword: [ServerAccount] {
        authManager.servers.filter { authManager.serverPassword(for: $0.id) == nil }
    }

    private var passwordsSection: some View {
        Section {
            ForEach(serversMissingPassword) { account in
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
                    Button("Add Password") {
                        passwordAccount = account
                    }
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.semibold))
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings-icloud-sync-password-\(account.id)")
            }
        } header: {
            Text("Passwords to Sync")
        } footer: {
            Text("These servers were signed in with a password before Talaria kept it. Add it once, or sign in to the server again, and it syncs from then on.")
        }
    }

    private var dangerSection: some View {
        Section {
            Button("Disconnect", role: .destructive) {
                isConfirmingDisconnect = true
            }
            .disabled(isConnectingRelay || isDeleting)
            .accessibilityIdentifier("settings-disconnect-relay")

            Button("Delete Synced Data…", role: .destructive) {
                isConfirmingDelete = true
            }
            .disabled(isDeleting)
            .accessibilityIdentifier("settings-icloud-sync-delete")
        } footer: {
            Text("Disconnecting keeps everything on this iPhone. Deleting removes Talaria's records from iCloud; other iCloud data is not affected.")
        }
    }

    // MARK: - Actions

    @MainActor
    private func loadRelayState() async {
        relayCredentials = TalariaRelayConfigurationStore.load()
        if let relayCredentials,
           relayCredentials.pendingRevocation != true,
           !relayCredentials.isExpired {
            relayAuthorized = await TalariaRelayAppleCredentialState.status(
                userID: relayCredentials.appleUserID
            ) != .revoked
        } else {
            relayAuthorized = false
        }
    }

    @MainActor
    private func handleAppleSignIn(_ result: Result<ASAuthorization, any Error>) {
        let nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
        appleNonce = TalariaRelayClient.makeAppleNonce()
        errorMessage = nil
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken else {
                errorMessage = String(localized: "Apple did not return an identity token.")
                return
            }
            // Sync needs only the Apple user; the relay needs the token exchange.
            coordinator.signInWithApple(userID: credential.user)
            Task { await coordinator.enableSync() }
            if server != nil {
                Task {
                    await connectRelay(identityToken: identityToken, appleUserID: credential.user, nonce: nonce)
                }
            }
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code != .canceled {
                errorMessage = error.localizedDescription
            }
        }
    }

    @MainActor
    private func connectRelay(identityToken: Data, appleUserID: String, nonce: String) async {
        guard !isConnectingRelay, let server else { return }
        isConnectingRelay = true
        defer { isConnectingRelay = false }
        do {
            let previous = TalariaRelayConfigurationStore.load()
            if let previous, previous.pendingRevocation == true {
                if previous.isExpired {
                    try TalariaRelayConfigurationStore.clear()
                } else {
                    try await RelayConnectionOperations.disconnect(credentials: previous)
                }
            }
            var signedIn = try await TalariaRelayClient.signIn(
                identityToken: identityToken,
                nonce: nonce,
                appleUserID: appleUserID,
                deviceID: previous?.deviceID
            )
            if previous?.appleUserID == appleUserID {
                signedIn.pairedPublisherIDs = previous?.pairedPublisherIDs
            }
            try TalariaRelayConfigurationStore.save(signedIn)
            relayAuthorized = true
            try await RelayConnectionOperations.pair(
                server: server,
                credentials: signedIn,
                headers: authManager.currentCustomHeaders
            )
            relayCredentials = TalariaRelayConfigurationStore.load()
        } catch {
            relayCredentials = TalariaRelayConfigurationStore.load()
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func disconnect() async {
        errorMessage = nil
        coordinator.disconnect()
        guard let credentials = TalariaRelayConfigurationStore.load() else { return }
        do {
            try await RelayConnectionOperations.disconnect(credentials: credentials)
            relayCredentials = nil
        } catch {
            var pending = credentials
            pending.pendingRevocation = true
            try? TalariaRelayConfigurationStore.save(pending)
            relayCredentials = pending
            errorMessage = error.localizedDescription
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
