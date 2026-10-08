import AuthenticationServices
import SwiftUI
import TalariaKit

struct RelayConnectionManagementView: View {
    private enum UnenrollmentScope {
        case thisIPhone
        case allDevices
    }

    private struct RelayPublisherRow: Identifiable {
        let id: String
        let server: URL
        let displayName: String
        let localAccount: ServerAccount?
    }

    @Bindable var authManager: AuthManager

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var credentials: TalariaRelayCredentials?
    @State private var publisherLabels: [String: String] = [:]
    @State private var connectingServerID: String?
    @State private var unenrollingServerID: String?
    @State private var unenrollmentAccount: RelayPublisherRow?
    @State private var isPresentingUnenrollment = false
    @State private var failedServerID: String?
    @State private var errorMessage: SettingsErrorText?
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
                ForEach(serverRows) { server in
                    serverRow(server)
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
    private func serverRow(_ server: RelayPublisherRow) -> some View {
        let state = state(for: server)
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    serverDetails(server)
                    serverStatus(server, state: state)
                }
            } else {
                HStack(spacing: 12) {
                    serverDetails(server)
                    Spacer(minLength: 12)
                    serverStatus(server, state: state)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("settings-relay-server-\(server.id)")
    }

    private func serverDetails(_ server: RelayPublisherRow) -> some View {
        let host = server.server.host ?? server.id
        return VStack(alignment: .leading, spacing: 3) {
            Text(server.displayName)
                .font(.body)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if host.localizedCaseInsensitiveCompare(server.displayName) != .orderedSame {
                Text(host)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
    }

    @ViewBuilder
    private func serverStatus(_ server: RelayPublisherRow, state: TalariaRelayConnectionState) -> some View {
        if connectingServerID == server.id || unenrollingServerID == server.id {
            ProgressView()
                .accessibilityLabel(connectingServerID == server.id ? "Connecting" : "Unenrolling")
        } else if let account = server.localAccount,
                  (state == .unpaired || failedServerID == server.id) {
            Button(failedServerID == server.id ? "Retry" : "Connect") {
                Task { await pair(server, account: account) }
            }
            .buttonStyle(.borderless)
            .font(.subheadline.weight(.semibold))
            .disabled(isBusy)
        } else if state == .connected {
            HStack(spacing: 8) {
                HStack(spacing: 5) {
                    Image(systemName: "checkmark.circle.fill")
                    Text(state.title)
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.green)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)

                Button {
                    unenrollmentAccount = server
                    isPresentingUnenrollment = true
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .frame(width: 44, height: 44)
                .disabled(isBusy)
                .accessibilityLabel("Enrollment options for \(server.displayName)")
                .accessibilityIdentifier("settings-unenroll-server-\(server.id)")
            }
            .layoutPriority(1)
        } else {
            Label(state.title, systemImage: "exclamationmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }

    private var isBusy: Bool {
        connectingServerID != nil || unenrollingServerID != nil || isDisconnecting
    }

    private var serverRows: [RelayPublisherRow] {
        let localRows = authManager.servers.compactMap { account -> RelayPublisherRow? in
            guard let server = URL(string: account.urlString),
                  let publisherID = TalariaRelayClient.originURL(server)?.absoluteString else { return nil }
            return RelayPublisherRow(
                id: publisherID,
                server: server,
                displayName: account.displayName,
                localAccount: account
            )
        }
        let localIDs = Set(localRows.map(\.id))
        let removedRows = (credentials?.pairedPublisherIDs ?? []).compactMap { value -> RelayPublisherRow? in
            guard let publisherID = TalariaRelayClient.originIdentifier(value),
                  !localIDs.contains(publisherID),
                  let server = URL(string: publisherID) else { return nil }
            let label = publisherLabels[publisherID]?.trimmingCharacters(in: .whitespacesAndNewlines)
            return RelayPublisherRow(
                id: publisherID,
                server: server,
                displayName: label.flatMap { $0.isEmpty ? nil : $0 } ?? server.host ?? publisherID,
                localAccount: nil
            )
        }
        return localRows + removedRows
    }

    private func state(for server: RelayPublisherRow) -> TalariaRelayConnectionState {
        TalariaRelayConfigurationStore.connectionState(for: server.server, credentials: credentials)
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
        publisherLabels = subscriptions.reduce(into: [:]) { labels, subscription in
            guard subscription.subscribed,
                  let publisherID = TalariaRelayClient.originIdentifier(subscription.publisherId) else { return }
            labels[publisherID] = subscription.label
        }
        try? TalariaRelayConfigurationStore.replacePairedPublishers(
            subscriptions.filter(\.subscribed).map(\.publisherId)
        )
        self.credentials = TalariaRelayConfigurationStore.load()
    }

    @MainActor
    private func pair(_ server: RelayPublisherRow, account: ServerAccount) async {
        guard connectingServerID == nil,
              !isBusy,
              let credentials else { return }
        connectingServerID = server.id
        failedServerID = nil
        errorMessage = nil
        defer { connectingServerID = nil }
        do {
            try await RelayConnectionOperations.pair(
                server: server.server,
                credentials: credentials,
                headers: authManager.customHeaders(for: account)
            )
            self.credentials = TalariaRelayConfigurationStore.load()
        } catch {
            self.credentials = TalariaRelayConfigurationStore.load()
            failedServerID = state(for: server) == .connected ? nil : server.id
            errorMessage = SettingsErrorText(error)
        }
    }

    @MainActor
    private func unenroll(_ server: RelayPublisherRow, scope: UnenrollmentScope) async {
        guard !isBusy,
              let credentials else { return }
        unenrollingServerID = server.id
        errorMessage = nil
        defer { unenrollingServerID = nil }
        do {
            let client = TalariaRelayClient(credentials: credentials)
            switch scope {
            case .thisIPhone:
                try await client.setPublisherSubscription(server.server, subscribed: false)
            case .allDevices:
                try await client.revokePublisher(server.server)
            }
            try TalariaRelayConfigurationStore.removePairedPublisher(server.server)
            publisherLabels.removeValue(forKey: server.id)
            self.credentials = TalariaRelayConfigurationStore.load()
            try await TalariaAggregateLiveActivityManager.shared.refresh()
        } catch {
            errorMessage = SettingsErrorText(error)
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
            errorMessage = SettingsErrorText(error)
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
        let client = TalariaRelayClient(credentials: credentials)
        let invitation = try await client.createPublisherInvitation()
        try await APIClient(baseURL: server, customHeaderProvider: { headers }).pairTalariaRelay(
            invitation: invitation,
            relayURL: credentials.baseURL,
            publisherID: publisherID
        )
        // A device signing in for the first time has no relay record to subscribe yet.
        try await client.configureDevice(pushToStartEnabled: TalariaLiveActivityMode.current == .allRunning)
        try await client.setPublisherSubscription(
            publisherID,
            subscribed: true
        )
        try TalariaRelayConfigurationStore.recordPairedPublisher(publisherID)
        await AgentLiveActivityManager.shared.refreshForCurrentMode()
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
