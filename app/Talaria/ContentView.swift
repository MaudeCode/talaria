import CoreSpotlight
import SwiftData
import SwiftUI
import TalariaKit

struct ContentView: View {
    @Bindable var authManager: AuthManager
    private let draftStore: ChatDraftStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.modelContext) private var modelContext
    /// This window, for the app-wide What's New and share routing that each pick one window (TAL-2387).
    @State private var window = UUID()
    /// This window's scene session, which events route by and its chats register under (TAL-2388).
    @State private var sceneID: String?
    /// Decided when the window opens: one opened beside another drafts New Chat under its own identity.
    @State private var opensBesideAnotherWindow = UIApplication.shared.hasSeveralWindows
    /// This window's chat on each server, which the system restores with the window (TAL-2387).
    @SceneStorage("sessionNavigation.windowSelections")
    private var windowSelections = SessionNavigationPersistence.WindowSelections()
    /// App-wide: `TalariaApp` imports shares once for every window.
    @State private var sharedImports: SharedImportRouter
    @State private var pendingDeepLinkedSessionID: String?
    @State private var pendingBotChat: TalariaDeepLink.BotChat?
    @State private var botChatServerUnavailable = false
    /// A utility destination opened once above the current screen.
    @State private var pendingDestination: SessionListUtilityDestination?
    @State private var opensProviderQuotaWidgetSettings = false
    @State private var pendingNewChatRequest: NewChatRequest?
    /// TAL-2623: the server an add-server link opens Add Server prefilled with.
    @State private var pendingAddServer: TalariaDeepLink.AddServer?
    private let acceptsAddServerLinks: Bool
    @State private var intentRouter: AppIntentRouter
    @Bindable private var whatsNew: WhatsNewPresenter
    private let appLock: AppLockModel

    init(
        authManager: AuthManager,
        draftStore: ChatDraftStore? = nil,
        whatsNew: WhatsNewPresenter? = nil,
        appLock: AppLockModel? = nil,
        intentRouter: AppIntentRouter? = nil,
        sharedImports: SharedImportRouter? = nil,
        acceptsAddServerLinks: Bool = TalariaDeepLink.acceptsAddServerLinks
    ) {
        self.authManager = authManager
        self.acceptsAddServerLinks = acceptsAddServerLinks
        self.draftStore = draftStore ?? .shared
        self.whatsNew = whatsNew ?? WhatsNewPresenter(pending: nil)
        self.appLock = appLock ?? .shared
        _intentRouter = State(initialValue: intentRouter ?? .shared)
        _sharedImports = State(initialValue: sharedImports ?? SharedImportRouter())
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.openSessionArgument) {
            _pendingDeepLinkedSessionID = State(initialValue: UITestFixtureURLProtocol.sessionID)
        }
        #endif
    }

    /// No sign-in, import, deep link or App Intent is waiting to take the screen, so What's New can be offered
    /// without hiding or replacing it (TAL-182).
    private var leavesRoomForWhatsNew: Bool {
        scenePhase == .active
            && authManager.pendingReauthentication == nil
            && sharedImports.pendingImport == nil && !sharedImports.hasWaitingImport
            && pendingDeepLinkedSessionID == nil && pendingDestination == nil
            && pendingBotChat == nil && !botChatServerUnavailable
            && !opensProviderQuotaWidgetSettings && pendingNewChatRequest == nil && pendingAddServer == nil
            && intentRouter.pendingRoute == nil
            && !appLock.isLocked && appLock.queuedDeepLinks.isEmpty
    }

    var body: some View {
        content
            .sheet(item: $pendingAddServer) { AddServerView(authManager: authManager, prefill: $0) }
            .alert("Bot Chat", isPresented: $botChatServerUnavailable) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("The server for this Bot Chat is no longer available.")
            }
            .whatsNewPresentation(whatsNew.presentation(in: window), defaults: whatsNew.defaults)
            .task(id: leavesRoomForWhatsNew) {
                guard leavesRoomForWhatsNew else { return }
                await whatsNew.offerWhenNothingIsPresented(in: window)
            }
            // A URL goes to a window already open rather than opening another (TAL-2387).
            .handlesExternalEvents(preferring: ["*"], allowing: ["*"])
            // TAL-2388: the router names the one window that handles the URL, which may be another one.
            .onOpenURL { url in
                intentRouter.requestDeepLink(url)
                drainPendingIntentRoute()
            }
            .onContinueUserActivity(CSSearchableItemActionType, perform: continueSessionActivity)
            .onContinueUserActivity(ChatHandoff.activityType, perform: continueSessionActivity)
            .background(WindowSceneReader { sceneID = $0 })
            .onChange(of: sceneID) { drainPendingIntentRoute() }
            .task {
                // Cold launch: an App Intent may have queued a deep link before this
                // view appeared (e.g. Action button "New Chat"). Drain it now (#337).
                drainPendingIntentRoute()
            }
            .onChange(of: intentRouter.pendingRoute) {
                drainPendingIntentRoute()
            }
            // TAL-2388: a link handed over from a closed window.
            .onChange(of: intentRouter.pendingWindow) { drainPendingIntentRoute() }
            .onChange(of: appLock.isLocked) {
                guard !appLock.isLocked else { return }
                drainPendingIntentRoute()
                // ponytail: one pending slot, so of several links queued behind the lock for other windows only the
                // last reaches its window; a queue in the router if that ever matters.
                for url in appLock.takeQueuedDeepLinks() {
                    intentRouter.requestDeepLink(url)
                    drainPendingIntentRoute()
                }
                Task { await importSharedDraftsUnlessLocked() }
            }
            // Inactive still counts: Control Center must not hand a share in flight to this window twice.
            .onChange(of: scenePhase, initial: true) {
                sharedImports.windowDidChange(window, isInForeground: scenePhase != .background)
                // A window brought forward for its event takes it once it is back (TAL-2388).
                drainPendingIntentRoute()
            }
            .onDisappear { sharedImports.windowDidChange(window, isInForeground: false) }
            .environment(\.newChatDraftWindow, newChatDraftWindow)
            .environment(\.windowSceneID, sceneID)
            .environment(\.windowOpener, .system)
            // TAL-2389: a window opened from a sidebar row's menu or drag starts at that chat or section.
            .onContinueUserActivity(OpenWindowTarget.activityType) { activity in
                switch OpenWindowTarget(activity: activity) {
                case .session(let id): pendingDeepLinkedSessionID = id
                case .section(let section): pendingDestination = section
                case nil: break
                }
            }
            .onAppear { windowSelections.keepNewChatDraftWindow(newChatDraftWindow) }
    }

    private var newChatDraftWindow: String? {
        windowSelections.newChatDraftWindow(proposed: opensBesideAnotherWindow ? window.uuidString : nil)
    }

    private func continueSessionActivity(_ activity: NSUserActivity) {
        TalariaApp.openSessionActivity(activity, servers: authManager.servers.map(\.id), in: intentRouter)
        drainPendingIntentRoute()
    }

    @ViewBuilder
    private var content: some View {
        switch authManager.state {
        case .unconfigured:
            OnboardingView(authManager: authManager)
                .onAppear { DisplayPhaseTrace.launchNotReached(.onboarding) }
        case .loggedOut(let server):
            OnboardingView(authManager: authManager, savedServer: server)
                .onAppear { DisplayPhaseTrace.launchNotReached(.onboarding) }
        case .loggedIn(let server):
            SessionListView(
                authManager: authManager,
                server: server,
                modelContext: modelContext,
                pendingSharedImport: Binding(
                    get: { sharedImports.pendingImport(in: window) },
                    set: { sharedImports.pendingImport = $0 }
                ),
                didRoutePendingSharedImport: { sharedImports.didRoute($0) },
                hasWaitingSharedImport: sharedImports.hasWaitingImport(in: window),
                openNextSharedImport: { sharedImports.openNext() },
                pendingDeepLinkedSessionID: $pendingDeepLinkedSessionID,
                pendingBotChat: $pendingBotChat,
                hasQueuedBotChat: hasQueuedBotChat,
                pendingDestination: $pendingDestination,
                opensProviderQuotaWidgetSettings: $opensProviderQuotaWidgetSettings,
                requestedNewChat: $pendingNewChatRequest,
                windowSelections: $windowSelections,
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

    private var hasQueuedBotChat: Bool {
        guard !appLock.isLocked, intentRouter.pendingWindow == nil || intentRouter.pendingWindow == sceneID,
              case .deepLink(let url)? = intentRouter.pendingRoute else { return false }
        return TalariaDeepLink.botChat(from: url) != nil
    }

    /// Every external route enters here, so a locked app holds it until unlock.
    private func handleOpenURL(_ url: URL) {
        guard appLock.admitDeepLink(url) else { return }
        route(url)
    }

    /// A share opens its chat and composer, so it waits behind the lock with the deep links.
    private func importSharedDraftsUnlessLocked() async {
        guard !appLock.isLocked else { return }
        await sharedImports.importIfAvailable()
    }

    private func route(_ url: URL) {
        if TalariaDeepLink.isOpenAppURL(url) {
            return
        }

        // TAL-2623: Talaria Dev opens Add Server prefilled and adds nothing until it is submitted; other builds ignore it.
        if let server = TalariaDeepLink.addServer(from: url) {
            if acceptsAddServerLinks { pendingAddServer = server }
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

        if let section = TalariaDeepLink.section(from: url) {
            switch section {
            case .tasks: pendingDestination = .tasks
            case .skills: pendingDestination = .skills
            case .tools: pendingDestination = .settings(.tools)
            case .system:
                guard let publisherID = TalariaDeepLink.publisherID(from: url),
                      let account = relayPublisherAccount(publisherID) else { return }
                authManager.switchActiveServer(to: account)
                guard authManager.activeServerID == account.id else { return }
                pendingDestination = .settings(.system)
            }
            return
        }

        // TAL-2327: a transcript row's Kanban card, on its board.
        if let card = TalariaDeepLink.kanbanCard(from: url) {
            pendingDestination = .kanbanCard(id: card.id, board: card.board)
            return
        }

        if let sourceID = TalariaDeepLink.quotaSourceID(from: url) {
            if TalariaDeepLink.requestsQuotaRefresh(url) {
                UserDefaults.standard.set(sourceID, forKey: ProviderQuotaWidgetLaunchAction.pendingRefreshSourceKey)
            }
            pendingDestination = .providers(sourceID)
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

        if let botChat = TalariaDeepLink.botChat(from: url) {
            if let account = authManager.servers.first(where: { $0.urlString == botChat.publisherID }) {
                authManager.switchActiveServer(to: account)
            }
            guard case let .loggedIn(server) = authManager.state, server.absoluteString == botChat.publisherID else {
                botChatServerUnavailable = true
                return
            }
            pendingBotChat = botChat
            return
        }

        if let sessionID = TalariaDeepLink.sessionID(from: url) {
            if let publisherID = TalariaDeepLink.publisherID(from: url),
               let account = relayPublisherAccount(publisherID) {
                authManager.switchActiveServer(to: account)
            }
            // TAL-1966: a decision review alert opens the review on that server rather than its chat.
            if let reviewID = TalariaDeepLink.decisionReviewID(from: url) {
                pendingDestination = .decisionReview(reviewID)
            } else {
                pendingDeepLinkedSessionID = sessionID
            }
            return
        }

        guard TalariaShareDraft.isShareOpenURL(url) else {
            return
        }

        Task { await sharedImports.importIfAvailable() }
    }

    private func relayPublisherAccount(_ publisherID: String) -> ServerAccount? {
        guard let origin = TalariaRelayClient.originIdentifier(publisherID) else { return nil }
        return authManager.servers.first { $0.id == publisherID }
            ?? authManager.servers.first { TalariaRelayClient.originIdentifier($0.urlString) == origin }
    }

    private func drainPendingIntentRoute() {
        // Keep Shortcut text in the router while locked. The lock's deep-link queue holds URLs only.
        if appLock.isLocked, case .newChat? = intentRouter.pendingRoute { return }
        switch intentRouter.takeRoute(in: sceneID) {
        case .deepLink(let url): handleOpenURL(url)
        case .newChat(let request): pendingNewChatRequest = request
        case nil: break
        }
    }
}

/// Reports the window scene a view sits in, which SwiftUI does not expose (TAL-2388), and names it with `title`
/// (TAL-2389).
struct WindowSceneReader: UIViewRepresentable {
    var title: String?
    var report: (String) -> Void = { _ in }

    func makeUIView(context: Context) -> ReaderView { ReaderView(report: report) }
    func updateUIView(_ view: ReaderView, context: Context) {
        view.title = title
        view.applyTitle()
    }

    final class ReaderView: UIView {
        let report: (String) -> Void
        var title: String?

        init(report: @escaping (String) -> Void) {
            self.report = report
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            applyTitle()
            // A server switch can detach the old reader after its replacement attaches.
            Task { @MainActor [weak self] in
                guard let self, let id = window?.windowScene?.windowSceneID else { return }
                report(id)
            }
        }

        /// The window's name in the app switcher and the system's window pickers.
        func applyTitle() {
            guard let title, let scene = window?.windowScene, scene.title != title else { return }
            scene.title = title
        }
    }
}

extension UIApplication {
    /// More than one Talaria window is connected (TAL-2387).
    var hasSeveralWindows: Bool {
        connectedScenes.filter { $0.session.role == .windowApplication }.count > 1
    }
}

#Preview {
    ContentView(authManager: AuthManager())
}
