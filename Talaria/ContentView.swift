import SwiftUI

struct ContentView: View {
    @Bindable var authManager: AuthManager
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var isResponseCompletionNotificationsEnabled = false
    @State private var pendingSharedImport: SharedImport?
    @State private var pendingDeepLinkedSessionID: String?
    @State private var pendingQuotaSourceID: String?
    @State private var opensProviderQuotaWidgetSettings = false
    @State private var pendingNewChatRequest: NewChatRequest?
    @State private var didCheckInitialPendingShare = false
    @State private var intentRouter = AppIntentRouter.shared

    var body: some View {
        content
            .onOpenURL(perform: handleOpenURL)
            .task {
                guard !didCheckInitialPendingShare else { return }
                didCheckInitialPendingShare = true
                await importPendingSharedDraftIfAvailable()
                // Cold launch: an App Intent may have queued a deep link before this
                // view appeared (e.g. Action button "New Chat"). Drain it now (#337).
                drainPendingIntentDeepLink()
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
                guard scenePhase == .active else { return }
                Task { await importPendingSharedDraftIfAvailable() }
                // #248: the foreground pass stays silent — the in-session completion
                // paths own notifications while the app is alive.
                Task { await reconcileOrphanedLiveActivities(notifiesOnCompletion: false) }
            }
    }

    private func reconcileOrphanedLiveActivities(notifiesOnCompletion: Bool) async {
        guard case let .loggedIn(server) = authManager.state else { return }
        await LiveActivityReconciler.reconcileOrphanedActivities(
            server: server,
            notifiesOnCompletion: notifiesOnCompletion,
            preferenceEnabled: isResponseCompletionNotificationsEnabled
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
                pendingSharedImport: $pendingSharedImport,
                pendingDeepLinkedSessionID: $pendingDeepLinkedSessionID,
                pendingQuotaSourceID: $pendingQuotaSourceID,
                opensProviderQuotaWidgetSettings: $opensProviderQuotaWidgetSettings,
                requestedNewChat: $pendingNewChatRequest
            )
            // Switching the active server keeps us in `.loggedIn`, so without a
            // per-server identity SwiftUI would reuse server-bound content.
            // Keying on the server tears the navigation tree down and rebuilds it against
            // the newly active server (#17).
            .id(server)
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
            pendingDeepLinkedSessionID = sessionID
            return
        }

        guard TalariaShareDraft.isShareOpenURL(url) else {
            return
        }

        Task { await importPendingSharedDraftIfAvailable() }
    }

    /// Routes a deep link queued by an App Intent through the same `handleOpenURL` parser
    /// used for external URLs, then clears it so it routes exactly once (#337).
    private func drainPendingIntentDeepLink() {
        guard let url = intentRouter.pendingDeepLink else { return }
        intentRouter.pendingDeepLink = nil
        handleOpenURL(url)
    }

    private func importPendingSharedDraftIfAvailable() async {
        guard let directory = TalariaShareDraft.containerURL() else {
            return
        }

        do {
            if let sharedImport = try await TalariaShareDraft.loadPendingImportOffMainActor(from: directory) {
                pendingSharedImport = sharedImport
            }
        } catch {}
    }
}

#Preview {
    ContentView(authManager: AuthManager())
}
