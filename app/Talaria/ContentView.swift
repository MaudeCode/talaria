import AuthenticationServices
import SwiftUI
import TalariaKit

struct ContentView: View {
    @Bindable var authManager: AuthManager
    private let draftStore: ChatDraftStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var isResponseCompletionNotificationsEnabled = false
    @State private var sharedImports = SharedImportRouter()
    @State private var foregroundReturn = ForegroundReturnDetector()
    @State private var pendingDeepLinkedSessionID: String?
    @State private var pendingQuotaSourceID: String?
    @State private var opensProviderQuotaWidgetSettings = false
    @State private var pendingNewChatRequest: NewChatRequest?
    @State private var didCheckInitialPendingShare = false
    @State private var intentRouter = AppIntentRouter.shared

    init(
        authManager: AuthManager,
        draftStore: ChatDraftStore? = nil
    ) {
        self.authManager = authManager
        self.draftStore = draftStore ?? .shared
    }

    var body: some View {
        content
            .onOpenURL(perform: handleOpenURL)
            .task {
                guard !didCheckInitialPendingShare else { return }
                didCheckInitialPendingShare = true
                await sharedImports.importIfAvailable()
                // Cold launch: an App Intent may have queued a deep link before this
                // view appeared (e.g. Action button "New Chat"). Drain it now (#337).
                drainPendingIntentDeepLink()
                ConfigurationSyncCoordinator.shared.attach(authManager: authManager)
                await refreshRelayIdentityAndActivity()
                await ConfigurationSyncCoordinator.shared.refreshOnForeground()
            }
            .onChange(of: intentRouter.pendingDeepLink) {
                // Warm launch: the intent set the deep link after the view appeared.
                drainPendingIntentDeepLink()
            }
            .task {
                // #246: on cold launch, end any Live Activity left "running" by a
                // run that finished while the app was terminated. #248: this is also
                // the one pass allowed to fire a recent run's "response complete"
                // notification, since a relaunch means it finished while not active.
                await reconcileOrphanedLiveActivities(notifiesOnCompletion: true)
            }
            .onChange(of: scenePhase) {
                if foregroundReturn.didReturnToForeground(on: scenePhase) {
                    // Every server-backed screen refreshes through `refreshesLive` (TAL-435).
                    NotificationCenter.default.post(name: .talariaReturnedToForeground, object: nil)
                }
                if scenePhase == .background {
                    ProviderQuotaBackgroundRefresh.schedule()
                    return
                }
                guard scenePhase == .active else { return }
                Task { await sharedImports.importIfAvailable() }
                // #248: the foreground pass stays silent — the in-session completion
                // paths own notifications while the app is alive.
                Task { await reconcileOrphanedLiveActivities(notifiesOnCompletion: false) }
                Task { await refreshRelayIdentityAndActivity() }
                Task { await ConfigurationSyncCoordinator.shared.refreshOnForeground() }
            }
            .onReceive(NotificationCenter.default.publisher(
                for: ASAuthorizationAppleIDProvider.credentialRevokedNotification
            )) { _ in
                ConfigurationSyncCoordinator.shared.handleAppleCredentialRevoked()
                Task { await invalidateRelayIdentity() }
            }
    }

    private func refreshRelayIdentityAndActivity() async {
        guard let credentials = TalariaRelayConfigurationStore.load() else { return }
        if credentials.pendingRevocation == true {
            do {
                try await TalariaAggregateLiveActivityManager.shared.disconnect()
                try await TalariaRelayClient(credentials: credentials).revokeSession()
                try TalariaRelayConfigurationStore.clear()
            } catch {
                return
            }
            return
        }
        let appleCredentialStatus = await TalariaRelayAppleCredentialState.status(
            userID: credentials.appleUserID
        )
        guard appleCredentialStatus != .revoked else {
            await invalidateRelayIdentity()
            return
        }
        if credentials.isExpired {
            try? await TalariaAggregateLiveActivityManager.shared.disconnect(preserveCompleted: true)
            return
        }
        guard appleCredentialStatus == .authorized else { return }
        try? await TalariaAggregateLiveActivityManager.shared.refresh()
    }

    private func invalidateRelayIdentity() async {
        guard var credentials = TalariaRelayConfigurationStore.load() else { return }
        do {
            try await TalariaAggregateLiveActivityManager.shared.disconnect()
            try await TalariaRelayClient(credentials: credentials).revokeSession()
            try TalariaRelayConfigurationStore.clear()
        } catch {
            credentials.pendingRevocation = true
            try? TalariaRelayConfigurationStore.save(credentials)
        }
    }

    private func reconcileOrphanedLiveActivities(notifiesOnCompletion: Bool) async {
        guard case let .loggedIn(server) = authManager.state else { return }
        await LiveActivityReconciler.reconcileOrphanedActivities(
            server: server,
            notifiesOnCompletion: notifiesOnCompletion,
            preferenceEnabled: isResponseCompletionNotificationsEnabled
                && !TalariaRelayConfigurationStore.ownsCompletionAlerts(for: server)
        )
    }

    @ViewBuilder
    private var content: some View {
        switch authManager.state {
        case .unconfigured:
            OnboardingView(authManager: authManager)
        case .loggedOut(let server):
            OnboardingView(authManager: authManager, savedServer: server)
        case .loggedIn(let server):
            SessionListView(
                authManager: authManager,
                server: server,
                pendingSharedImport: $sharedImports.pendingImport,
                didRoutePendingSharedImport: { sharedImports.didRoute($0) },
                hasWaitingSharedImport: sharedImports.hasWaitingImport,
                openNextSharedImport: { sharedImports.openNext() },
                pendingDeepLinkedSessionID: $pendingDeepLinkedSessionID,
                pendingQuotaSourceID: $pendingQuotaSourceID,
                opensProviderQuotaWidgetSettings: $opensProviderQuotaWidgetSettings,
                requestedNewChat: $pendingNewChatRequest,
                draftStore: draftStore
            )
            // Switching the active server keeps us in `.loggedIn`, so without a
            // per-server identity SwiftUI would reuse server-bound content.
            // Keying on the server tears the navigation tree down and rebuilds it against
            // the newly active server (#17).
            .id("\(server.absoluteString)#\(authManager.authenticatedIdentityRevision)")
            .disabled(authManager.pendingReauthentication != nil)
            .sheet(isPresented: Binding(
                get: { authManager.pendingReauthentication != nil },
                set: { _ in }
            )) {
                if let server = authManager.pendingReauthentication {
                    ReauthenticationSheet(authManager: authManager, server: server)
                        .environment(\.isEnabled, true)
                }
            }
        }
    }

    private func handleOpenURL(_ url: URL) {
        if TalariaDeepLink.isOpenAppURL(url) {
            return
        }

        if let providerID = TalariaDeepLink.providerID(fromNewChatWithProvider: url) {
            pendingNewChatRequest = NewChatRequest(providerID: providerID)
            return
        }

        if TalariaDeepLink.isProviderQuotaWidgetSettingsURL(url) {
            opensProviderQuotaWidgetSettings = true
            return
        }

        if let sourceID = TalariaDeepLink.quotaSourceID(from: url) {
            if TalariaDeepLink.requestsQuotaRefresh(url) {
                UserDefaults.standard.set(sourceID, forKey: ProviderQuotaWidgetLaunchAction.pendingRefreshSourceKey)
            }
            pendingQuotaSourceID = sourceID
            return
        }

        // A fresh request each time (new `id`) so a repeat invocation re-triggers navigation
        // even if the previous one's value still lingers downstream. The voice variant carries
        // `autoStartsVoiceInput` so the composer begins dictation once it appears (#338).
        if TalariaDeepLink.isNewChatVoiceURL(url) {
            pendingNewChatRequest = NewChatRequest(autoStartsVoiceInput: true)
            return
        }

        // The profile variant carries the chosen profile name, so the composer creates the
        // session pinned to it (#339). A malformed link with no profile falls back to a
        // plain new chat (server's active profile) rather than failing.
        if TalariaDeepLink.isNewChatInProfileURL(url) {
            pendingNewChatRequest = NewChatRequest(
                profileName: TalariaDeepLink.profileName(fromNewChatInProfile: url)
            )
            return
        }

        if TalariaDeepLink.isNewChatURL(url) {
            pendingNewChatRequest = NewChatRequest(autoStartsVoiceInput: false)
            return
        }

        if let sessionID = TalariaDeepLink.sessionID(from: url) {
            if let publisherID = TalariaDeepLink.publisherID(from: url),
               let canonicalPublisherID = TalariaRelayClient.originIdentifier(publisherID),
               let account = authManager.servers.first(where: {
                   TalariaRelayClient.originIdentifier($0.urlString) == canonicalPublisherID
               }) {
                authManager.switchActiveServer(to: account)
            }
            pendingDeepLinkedSessionID = sessionID
            return
        }

        guard TalariaShareDraft.isShareOpenURL(url) else {
            return
        }

        Task { await sharedImports.importIfAvailable() }
    }

    /// Routes a deep link queued by an App Intent through the same `handleOpenURL` parser
    /// used for external URLs, then clears it so it routes exactly once (#337).
    private func drainPendingIntentDeepLink() {
        guard let url = intentRouter.pendingDeepLink else { return }
        intentRouter.pendingDeepLink = nil
        handleOpenURL(url)
    }
}

#Preview {
    ContentView(authManager: AuthManager())
}
