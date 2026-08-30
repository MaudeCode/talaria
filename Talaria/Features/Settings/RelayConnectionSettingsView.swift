import AuthenticationServices
import SwiftUI

struct RelayAccountSettingsSection: View {
    @Bindable var authManager: AuthManager
    let server: URL

    @Environment(\.colorScheme) private var colorScheme
    @State private var appleNonce = TalariaRelayClient.makeAppleNonce()
    @State private var credentials: TalariaRelayCredentials?
    @State private var appleAuthorized = false
    @State private var isLoading = true
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch connectionState {
            case .signedOut, .expired, .disconnectPending:
                accountSummary

                SignInWithAppleButton(.continue) { request in
                    request.nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
                } onCompletion: { result in
                    handleAppleSignIn(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 46)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .disabled(isLoading || isConnecting)
                .accessibilityIdentifier("settings-sign-in-with-apple")
            case .unpaired, .connected:
                NavigationLink {
                    RelayConnectionManagementView(authManager: authManager)
                } label: {
                    accountSummary
                }
                .accessibilityHint("Opens Talaria Relay connection management.")
                .accessibilityIdentifier("settings-manage-relay")
            }

            if let errorMessage {
                SettingsErrorFootnote(errorMessage)
            }
        }
        .padding(.vertical, 2)
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
        switch connectionState {
        case .connected: return String(localized: "Connected to \(activeServerName)")
        case .unpaired: return String(localized: "Connect \(activeServerName)")
        case .signedOut: return String(localized: "Sign in for remote Live Activities and alerts")
        case .expired, .disconnectPending: return connectionState.title
        }
    }

    private var activeServerName: String {
        authManager.servers.first(where: { $0.id == authManager.activeServerID })?.displayName
            ?? server.host
            ?? server.absoluteString
    }

    private var accountSummary: some View {
        HStack(spacing: 12) {
            Image(systemName: "apple.logo")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("Talaria Relay")
                    .font(.body.weight(.semibold))

                Text(summaryText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            if isLoading || isConnecting {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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
    private enum UnenrollmentScope {
        case thisIPhone
        case allDevices
    }

    @Bindable var authManager: AuthManager

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var credentials: TalariaRelayCredentials?
    @State private var connectingServerID: String?
    @State private var unenrollingServerID: String?
    @State private var unenrollmentAccount: ServerAccount?
    @State private var isPresentingUnenrollment = false
    @State private var failedServerID: String?
    @State private var errorMessage: String?
    @State private var isConfirmingDisconnect = false
    @State private var isDisconnecting = false

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    SettingsErrorFootnote(errorMessage)
                }
            }

            Section("Servers") {
                ForEach(authManager.servers) { account in
                    serverRow(account)
                }
            }

            Section {
                Button("Sign Out of Talaria Relay", role: .destructive) {
                    isConfirmingDisconnect = true
                }
                .disabled(isBusy || credentials == nil)
                .accessibilityIdentifier("settings-disconnect-relay")
            } footer: {
                Text("Signing out stops remote Live Activities and alerts. Your server settings stay on this iPhone.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Talaria Relay")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadCredentials() }
        .alert(
            unenrollmentAccount.map { String(localized: "Unenroll \($0.displayName)?") }
                ?? String(localized: "Unenroll Server?"),
            isPresented: $isPresentingUnenrollment,
            presenting: unenrollmentAccount
        ) { account in
            Button("This iPhone", role: .destructive) {
                Task { await unenroll(account, scope: .thisIPhone) }
            }
            .accessibilityIdentifier("settings-unenroll-this-iphone")

            Button("All Devices", role: .destructive) {
                Task { await unenroll(account, scope: .allDevices) }
            }
            .accessibilityIdentifier("settings-unenroll-all-devices")

            Button("Cancel", role: .cancel) {}
        } message: { account in
            Text("Choose whether \(account.displayName) stops sending relay updates to this iPhone or every device on this Talaria Relay account.")
        }
        .alert("Sign out of Talaria Relay?", isPresented: $isConfirmingDisconnect) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out", role: .destructive) {
                Task { await disconnect() }
            }
        } message: {
            Text("This signs this iPhone out of Talaria Relay. Your Hermes server settings stay on the device.")
        }
    }

    @ViewBuilder
    private func serverRow(_ account: ServerAccount) -> some View {
        let state = state(for: account)
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    serverDetails(account)
                    serverStatus(account, state: state)
                }
            } else {
                HStack(spacing: 12) {
                    serverDetails(account)
                    Spacer(minLength: 12)
                    serverStatus(account, state: state)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("settings-relay-server-\(account.id)")
    }

    private func serverDetails(_ account: ServerAccount) -> some View {
        let host = URL(string: account.urlString)?.host ?? account.urlString
        return VStack(alignment: .leading, spacing: 3) {
            Text(account.displayName)
                .font(.body)
            if host.localizedCaseInsensitiveCompare(account.displayName) != .orderedSame {
                Text(host)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
    }

    @ViewBuilder
    private func serverStatus(_ account: ServerAccount, state: TalariaRelayConnectionState) -> some View {
        if connectingServerID == account.id || unenrollingServerID == account.id {
            ProgressView()
                .accessibilityLabel(connectingServerID == account.id ? "Connecting" : "Unenrolling")
        } else if state == .unpaired || failedServerID == account.id {
            Button(failedServerID == account.id ? "Retry" : "Connect") {
                Task { await pair(account) }
            }
            .buttonStyle(.borderless)
            .font(.subheadline.weight(.semibold))
            .disabled(isBusy)
        } else if state == .connected {
            VStack(alignment: .trailing, spacing: 5) {
                Label(state.title, systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.green)

                Button("Unenroll", role: .destructive) {
                    unenrollmentAccount = account
                    isPresentingUnenrollment = true
                }
                .buttonStyle(.borderless)
                .font(.caption.weight(.semibold))
                .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                .contentShape(Rectangle())
                .disabled(isBusy)
                .accessibilityIdentifier("settings-unenroll-server-\(account.id)")
            }
        } else {
            Label(state.title, systemImage: "exclamationmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }

    private var isBusy: Bool {
        connectingServerID != nil || unenrollingServerID != nil || isDisconnecting
    }

    private func state(for account: ServerAccount) -> TalariaRelayConnectionState {
        guard let server = URL(string: account.urlString) else { return .unpaired }
        return TalariaRelayConfigurationStore.connectionState(for: server, credentials: credentials)
    }

    @MainActor
    private func loadCredentials() async {
        credentials = TalariaRelayConfigurationStore.load()
        guard let credentials else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.relayConnectedArgument) {
            return
        }
        #endif
        guard let subscriptions = try? await TalariaRelayClient(credentials: credentials).publisherSubscriptions() else {
            return
        }
        try? TalariaRelayConfigurationStore.replacePairedPublishers(
            subscriptions.filter(\.subscribed).map(\.publisherId)
        )
        self.credentials = TalariaRelayConfigurationStore.load()
    }

    @MainActor
    private func pair(_ account: ServerAccount) async {
        guard connectingServerID == nil,
              !isBusy,
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
    private func unenroll(_ account: ServerAccount, scope: UnenrollmentScope) async {
        guard !isBusy,
              let credentials,
              let server = URL(string: account.urlString),
              let publisherID = TalariaRelayClient.originURL(server) else { return }
        unenrollingServerID = account.id
        errorMessage = nil
        defer { unenrollingServerID = nil }
        do {
            let client = TalariaRelayClient(credentials: credentials)
            switch scope {
            case .thisIPhone:
                try await client.setPublisherSubscription(publisherID, subscribed: false)
            case .allDevices:
                try await client.revokePublisher(publisherID)
            }
            try TalariaRelayConfigurationStore.removePairedPublisher(publisherID)
            self.credentials = TalariaRelayConfigurationStore.load()
            try await TalariaAggregateLiveActivityManager.shared.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func disconnect() async {
        guard !isBusy,
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
        try await TalariaRelayClient(credentials: credentials).setPublisherSubscription(
            publisherID,
            subscribed: true
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
