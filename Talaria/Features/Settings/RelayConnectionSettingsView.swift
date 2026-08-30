import AuthenticationServices
import SwiftUI

struct RelayAccountSettingsSection: View {
    @Bindable var authManager: AuthManager
    let server: URL

    @State private var appleNonce = TalariaRelayClient.makeAppleNonce()
    @State private var credentials: TalariaRelayCredentials?
    @State private var appleAuthorized = false
    @State private var isLoading = true
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "apple.logo")
                    .font(.title2)
                    .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Apple Account")
                        .font(.body.weight(.semibold))

                    Text(summaryText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                if isLoading || isConnecting {
                    ProgressView()
                } else if connectionState == .connected {
                    SettingsStatusPill(label: String(localized: "Connected"))
                }
            }

            if let errorMessage {
                SettingsErrorFootnote(errorMessage)
            }

            switch connectionState {
            case .signedOut, .expired, .disconnectPending:
                SignInWithAppleButton(.continue) { request in
                    request.nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
                } onCompletion: { result in
                    handleAppleSignIn(result)
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .disabled(isLoading || isConnecting)
                .accessibilityIdentifier("settings-sign-in-with-apple")
            case .unpaired, .connected:
                NavigationLink {
                    RelayConnectionManagementView(authManager: authManager)
                } label: {
                    SettingsAccessoryRow(
                        title: activeServerName,
                        value: connectionState.title,
                        systemImage: "server.rack"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens Apple account and server connection management.")
                .accessibilityIdentifier("settings-manage-relay")
            }
        }
        .padding(.vertical, 4)
        .onAppear {
            Task { await loadState() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-apple-account")
    }

    private var connectionState: TalariaRelayConnectionState {
        guard !isLoading else { return .signedOut }
        guard credentials == nil || appleAuthorized else { return .expired }
        return TalariaRelayConfigurationStore.connectionState(for: server, credentials: credentials)
    }

    private var summaryText: String {
        if isLoading { return String(localized: "Checking connection…") }
        if isConnecting { return String(localized: "Connecting…") }
        return connectionState.title
    }

    private var activeServerName: String {
        authManager.servers.first(where: { $0.id == authManager.activeServerID })?.displayName
            ?? server.host
            ?? server.absoluteString
    }

    @MainActor
    private func loadState() async {
        isLoading = true
        credentials = TalariaRelayConfigurationStore.load()
        if let credentials,
           credentials.pendingRevocation != true,
           !credentials.isExpired {
            appleAuthorized = await TalariaRelayAppleCredentialState.isAuthorized(userID: credentials.appleUserID)
        } else {
            appleAuthorized = false
        }
        isLoading = false
    }

    @MainActor
    private func handleAppleSignIn(_ result: Result<ASAuthorization, any Error>) {
        let nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
        appleNonce = TalariaRelayClient.makeAppleNonce()
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken else {
                errorMessage = String(localized: "Apple did not return an identity token.")
                return
            }
            Task {
                await connect(
                    identityToken: identityToken,
                    appleUserID: credential.user,
                    nonce: nonce
                )
            }
        case .failure(let error):
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func connect(identityToken: Data, appleUserID: String, nonce: String) async {
        guard !isConnecting else { return }
        isConnecting = true
        errorMessage = nil
        defer { isConnecting = false }
        do {
            let previous = TalariaRelayConfigurationStore.load()
            if let previous, previous.pendingRevocation == true {
                try await RelayConnectionOperations.disconnect(credentials: previous)
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
            appleAuthorized = true
            try await RelayConnectionOperations.pair(
                server: server,
                credentials: signedIn,
                headers: authManager.currentCustomHeaders
            )
            credentials = TalariaRelayConfigurationStore.load()
        } catch {
            credentials = TalariaRelayConfigurationStore.load()
            errorMessage = error.localizedDescription
        }
    }
}

struct RelayConnectionManagementView: View {
    @Bindable var authManager: AuthManager

    @State private var credentials: TalariaRelayCredentials?
    @State private var connectingServerID: String?
    @State private var failedServerID: String?
    @State private var errorMessage: String?
    @State private var isConfirmingDisconnect = false
    @State private var isDisconnecting = false

    var body: some View {
        SettingsPage(title: String(localized: "Apple Account")) {
            SettingsCard(title: String(localized: "Connection")) {
                SettingsValueRow(title: String(localized: "Apple Account")) {
                    SettingsStatusPill(label: globalStatus)
                }

                if let errorMessage {
                    SettingsErrorFootnote(errorMessage)
                }
            }

            SettingsCard(title: String(localized: "Servers")) {
                ForEach(authManager.servers) { account in
                    if account.id != authManager.servers.first?.id {
                        SettingsDivider()
                    }
                    serverRow(account)
                }
            }

            SettingsCard(title: String(localized: "Account")) {
                SettingsFootnote(String(localized: "Disconnecting stops relay Live Activities and alerts but keeps local server setup."))

                Button("Disconnect Apple Account", role: .destructive) {
                    isConfirmingDisconnect = true
                }
                .buttonStyle(.bordered)
                .disabled(isDisconnecting || connectingServerID != nil || credentials == nil)
                .accessibilityIdentifier("settings-disconnect-relay")
            }
        }
        .task { credentials = TalariaRelayConfigurationStore.load() }
        .alert("Disconnect Apple account?", isPresented: $isConfirmingDisconnect) {
            Button("Cancel", role: .cancel) {}
            Button("Disconnect", role: .destructive) {
                Task { await disconnect() }
            }
        } message: {
            Text("This stops relay delivery and signs this device out of the Talaria relay. Your Hermes server setup stays on this device.")
        }
    }

    @ViewBuilder
    private func serverRow(_ account: ServerAccount) -> some View {
        let state = state(for: account)
        VStack(alignment: .leading, spacing: 8) {
            SettingsValueRow(title: account.displayName) {
                if connectingServerID == account.id {
                    ProgressView()
                } else {
                    SettingsStatusPill(
                        label: failedServerID == account.id ? String(localized: "Failed") : state.title,
                        tint: state == .connected ? .green : .secondary
                    )
                }
            }

            Text(URL(string: account.urlString)?.host ?? account.urlString)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .lineLimit(1)

            if state == .unpaired || failedServerID == account.id {
                Button(failedServerID == account.id ? "Retry" : "Connect") {
                    Task { await pair(account) }
                }
                .buttonStyle(.bordered)
                .disabled(connectingServerID != nil || isDisconnecting)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue(failedServerID == account.id ? String(localized: "Failed") : state.title)
        .accessibilityIdentifier("settings-relay-server-\(account.id)")
    }

    private var globalStatus: String {
        guard let credentials else { return String(localized: "Signed Out") }
        if credentials.pendingRevocation == true { return String(localized: "Disconnect Pending") }
        if credentials.isExpired { return String(localized: "Sign In Required") }
        return String(localized: "Connected")
    }

    private func state(for account: ServerAccount) -> TalariaRelayConnectionState {
        guard let server = URL(string: account.urlString) else { return .unpaired }
        return TalariaRelayConfigurationStore.connectionState(for: server, credentials: credentials)
    }

    @MainActor
    private func pair(_ account: ServerAccount) async {
        guard connectingServerID == nil,
              !isDisconnecting,
              let credentials,
              let server = URL(string: account.urlString) else { return }
        connectingServerID = account.id
        failedServerID = nil
        errorMessage = nil
        defer { connectingServerID = nil }
        do {
            try await RelayConnectionOperations.pair(
                server: server,
                credentials: credentials,
                headers: authManager.customHeaders(for: account)
            )
            self.credentials = TalariaRelayConfigurationStore.load()
        } catch {
            failedServerID = account.id
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func disconnect() async {
        guard !isDisconnecting,
              connectingServerID == nil,
              let credentials else { return }
        isDisconnecting = true
        errorMessage = nil
        defer { isDisconnecting = false }
        do {
            try await RelayConnectionOperations.disconnect(credentials: credentials)
            self.credentials = nil
        } catch {
            var pending = credentials
            pending.pendingRevocation = true
            try? TalariaRelayConfigurationStore.save(pending)
            self.credentials = pending
            errorMessage = error.localizedDescription
        }
    }
}

enum RelayConnectionOperations {
    static func pair(
        server: URL,
        credentials: TalariaRelayCredentials,
        headers: [CustomHeader]
    ) async throws {
        guard let publisherID = TalariaRelayClient.originURL(server) else {
            throw TalariaRelayClient.ClientError.invalidURL
        }
        let invitation = try await TalariaRelayClient(credentials: credentials).createPublisherInvitation()
        try await APIClient(baseURL: server, customHeaderProvider: { headers }).pairTalariaRelay(
            invitation: invitation,
            relayURL: credentials.baseURL,
            publisherID: publisherID
        )
        try TalariaRelayConfigurationStore.recordPairedPublisher(publisherID)
        try await TalariaAggregateLiveActivityManager.shared.refresh()
    }

    static func disconnect(credentials: TalariaRelayCredentials) async throws {
        try await TalariaAggregateLiveActivityManager.shared.disconnect()
        try TalariaRelayConfigurationStore.clear()
        do {
            try await TalariaRelayClient(credentials: credentials).revokeSession()
        } catch {
            var pending = credentials
            pending.pendingRevocation = true
            try? TalariaRelayConfigurationStore.save(pending)
            throw error
        }
    }
}
