import AuthenticationServices
import SwiftUI
import UIKit

struct RelayLiveActivitySettingsCard: View {
    let server: URL

    @State private var appleNonce = TalariaRelayClient.makeAppleNonce()
    @State private var statusMessage: String?
    @State private var isConnecting = false
    @State private var isConfigured = false
    @AppStorage(TalariaLiveActivityMode.storageKey) private var modeRawValue = TalariaLiveActivityMode.perSession.rawValue
    @AppStorage(TalariaRelayNotifications.isEnabledKey) private var notificationsEnabled = false

    var body: some View {
        SettingsCard(title: String(localized: "Live Activities")) {
            SettingsPickerRow(
                title: String(localized: "Display"),
                systemImage: "bolt.horizontal.circle",
                selection: $modeRawValue
            ) {
                ForEach(TalariaLiveActivityMode.allCases) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            }

            if modeRawValue == TalariaLiveActivityMode.allRunning.rawValue {
                relayControls
            }
        }
        .task { await loadRelayState() }
        .onChange(of: modeRawValue) {
            Task { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
        }
    }

    @ViewBuilder
    private var relayControls: some View {
        SettingsDivider()
        SettingsToggleRow(
            title: String(localized: "Approval & Input Alerts"),
            systemImage: "bell.badge",
            isOn: notificationBinding
        )
        SettingsDivider()
        SettingsFootnote(
            statusMessage
                ?? String(localized: "Sign in with Apple, then Talaria securely pairs this Hermes server with your Live Activities.")
        )

        if isConfigured {
            SettingsButton(String(localized: "Connect This Server"), isLoading: isConnecting) {
                Task { await pairCurrentServer() }
            }
            .disabled(isConnecting)
        } else {
            SignInWithAppleButton(.continue) { request in
                request.nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
            } onCompletion: { result in
                handleAppleSignIn(result)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .disabled(isConnecting)
        }

        if isConfigured {
            SettingsButton(String(localized: "Disconnect Relay"), role: .destructive) {
                Task { await disconnect() }
            }
        }
    }

    private var notificationBinding: Binding<Bool> {
        Binding(
            get: { notificationsEnabled },
            set: { enabled in
                if enabled {
                    Task { await enableNotifications() }
                } else {
                    notificationsEnabled = false
                    Task { try? await TalariaAggregateLiveActivityManager.shared.refresh() }
                }
            }
        )
    }

    @MainActor
    private func loadRelayState() async {
        guard let credentials = TalariaRelayConfigurationStore.load() else { return }
        let appleAuthorized = await TalariaRelayAppleCredentialState.isAuthorized(
            userID: credentials.appleUserID
        )
        isConfigured = !credentials.isExpired && appleAuthorized
        statusMessage = isConfigured
            ? String(localized: "Connected")
            : String(localized: "Sign in with Apple again to restore remote Live Activities.")
    }

    @MainActor
    private func handleAppleSignIn(_ result: Result<ASAuthorization, any Error>) {
        let nonce = TalariaRelayClient.hashedAppleNonce(appleNonce)
        appleNonce = TalariaRelayClient.makeAppleNonce()
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken else {
                statusMessage = String(localized: "Apple did not return an identity token.")
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
            statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func connect(identityToken: Data, appleUserID: String, nonce: String) async {
        isConnecting = true
        defer { isConnecting = false }
        do {
            var credentials = try await TalariaRelayClient.signIn(
                identityToken: identityToken,
                nonce: nonce,
                appleUserID: appleUserID,
                deviceID: TalariaRelayConfigurationStore.load()?.deviceID
            )
            let pendingRevocation = TalariaRelayConfigurationStore.load()?.pendingRevocation == true
            credentials.pendingRevocation = pendingRevocation
            try TalariaRelayConfigurationStore.save(credentials)
            if pendingRevocation {
                await disconnect()
                return
            }
            isConfigured = true
            try await pair(using: credentials)
            try await TalariaAggregateLiveActivityManager.shared.refresh()
            statusMessage = String(localized: "Connected")
        } catch {
            if case TalariaRelayClient.ClientError.invalidResponse(401, _) = error {
                isConfigured = false
            }
            statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func pairCurrentServer() async {
        isConnecting = true
        defer { isConnecting = false }
        do {
            guard let credentials = TalariaRelayConfigurationStore.load() else {
                isConfigured = false
                return
            }
            try await pair(using: credentials)
            try await TalariaAggregateLiveActivityManager.shared.refresh()
            statusMessage = String(localized: "Connected")
        } catch {
            if case TalariaRelayClient.ClientError.invalidResponse(401, _) = error {
                isConfigured = false
            }
            statusMessage = error.localizedDescription
        }
    }

    private func pair(using credentials: TalariaRelayCredentials) async throws {
        guard let publisherID = TalariaRelayClient.originURL(server) else {
            throw TalariaRelayClient.ClientError.invalidURL
        }
        let invitation = try await TalariaRelayClient(credentials: credentials).createPublisherInvitation()
        try await APIClient(baseURL: server).pairTalariaRelay(
            invitation: invitation,
            relayURL: credentials.baseURL,
            publisherID: publisherID
        )
    }

    @MainActor
    private func enableNotifications() async {
        let granted = await ResponseCompletionNotificationService.requestAuthorization()
        notificationsEnabled = granted
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
            statusMessage = nil
        } else {
            statusMessage = String(localized: "Notification permission is required for relay alerts.")
        }
        try? await TalariaAggregateLiveActivityManager.shared.refresh()
    }

    @MainActor
    private func disconnect() async {
        guard var credentials = TalariaRelayConfigurationStore.load() else { return }
        do {
            try await TalariaAggregateLiveActivityManager.shared.disconnect()
            try await TalariaRelayClient(credentials: credentials).revokeSession()
            try TalariaRelayConfigurationStore.clear()
            isConfigured = false
            statusMessage = String(localized: "Disconnected")
        } catch {
            credentials.pendingRevocation = true
            try? TalariaRelayConfigurationStore.save(credentials)
            isConfigured = false
            statusMessage = error.localizedDescription
        }
    }
}
