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
    /// A widget's quota account or a push's decision review, pushed once above the current screen.
    @State private var pendingDestination: SessionListUtilityDestination?
    @State private var opensProviderQuotaWidgetSettings = false
    @State private var pendingNewChatRequest: NewChatRequest?
    @State private var intentRouter: AppIntentRouter
    @Bindable private var whatsNew: WhatsNewPresenter
    private let appLock: AppLockModel

    init(
        authManager: AuthManager,
        draftStore: ChatDraftStore? = nil,
        whatsNew: WhatsNewPresenter? = nil,
        appLock: AppLockModel? = nil,
        intentRouter: AppIntentRouter? = nil,
        sharedImports: SharedImportRouter? = nil
    ) {
        self.authManager = authManager
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
            && !opensProviderQuotaWidgetSettings && pendingNewChatRequest == nil
            && intentRouter.pendingDeepLink == nil
            && !appLock.isLocked && appLock.queuedDeepLinks.isEmpty
    }

    var body: some View {
        content
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
                drainPendingIntentDeepLink()
            }
            .background(WindowSceneReader { sceneID = $0 })
            .onChange(of: sceneID) { drainPendingIntentDeepLink() }
            .task {
                // Cold launch: an App Intent may have queued a deep link before this
                // view appeared (e.g. Action button "New Chat"). Drain it now (#337).
                drainPendingIntentDeepLink()
            }
            .onChange(of: intentRouter.pendingDeepLink) {
                // Warm launch: the intent set the deep link after the view appeared.
                drainPendingIntentDeepLink()
            }
            // TAL-2388: a link handed over from a closed window.
            .onChange(of: intentRouter.pendingWindow) { drainPendingIntentDeepLink() }
            .onChange(of: appLock.isLocked) {
                guard !appLock.isLocked else { return }
                // ponytail: one pending slot, so of several links queued behind the lock for other windows only the
                // last reaches its window; a queue in the router if that ever matters.
                for url in appLock.takeQueuedDeepLinks() {
                    intentRouter.requestDeepLink(url)
                    drainPendingIntentDeepLink()
                }
                Task { await importSharedDraftsUnlessLocked() }
            }
            // Inactive still counts: Control Center must not hand a share in flight to this window twice.
            .onChange(of: scenePhase, initial: true) {
                sharedImports.windowDidChange(window, isInForeground: scenePhase != .background)
                // A window brought forward for its event takes it once it is back (TAL-2388).
                drainPendingIntentDeepLink()
            }
            .onDisappear { sharedImports.windowDidChange(window, isInForeground: false) }
            .environment(\.newChatDraftWindow, newChatDraftWindow)
            .environment(\.windowSceneID, sceneID)
            .onAppear { windowSelections.keepNewChatDraftWindow(newChatDraftWindow) }
    }

    private var newChatDraftWindow: String? {
        windowSelections.newChatDraftWindow(proposed: opensBesideAnotherWindow ? window.uuidString : nil)
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

        if let providerID = TalariaDeepLink.providerID(fromNewChatWithProvider: url) {
            pendingNewChatRequest = NewChatRequest(providerID: providerID)
            return
        }

        if TalariaDeepLink.isProviderQuotaWidgetSettingsURL(url) {
            opensProviderQuotaWidgetSettings = true
            return
        }

        // TAL-2326: a transcript row's Tasks, Skills or Settings › Tools page.
        if let section = TalariaDeepLink.section(from: url) {
            pendingDestination = switch section {
            case .tasks: .tasks
            case .skills: .skills
            case .tools: .settings(.tools)
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

        if let sessionID = TalariaDeepLink.sessionID(from: url) {
            if let publisherID = TalariaDeepLink.publisherID(from: url),
               let canonicalPublisherID = TalariaRelayClient.originIdentifier(publisherID),
               let account = authManager.servers.first(where: {
                   TalariaRelayClient.originIdentifier($0.urlString) == canonicalPublisherID
               }) {
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

    /// Routes a deep link queued by an App Intent through the same `handleOpenURL` parser
    /// used for external URLs, then clears it so it routes exactly once (#337), in the one window it belongs to (TAL-2388).
    private func drainPendingIntentDeepLink() {
        guard let url = intentRouter.takeDeepLink(in: sceneID) else { return }
        handleOpenURL(url)
    }
}

/// Reports the window scene a view sits in, which SwiftUI does not expose (TAL-2388).
private struct WindowSceneReader: UIViewRepresentable {
    let report: (String?) -> Void

    func makeUIView(context: Context) -> ReaderView { ReaderView(report: report) }
    func updateUIView(_ view: ReaderView, context: Context) {}

    final class ReaderView: UIView {
        let report: (String?) -> Void

        init(report: @escaping (String?) -> Void) {
            self.report = report
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            let id = window?.windowScene?.windowSceneID
            // Outside the view update that moved it.
            Task { @MainActor in report(id) }
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
