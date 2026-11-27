import AuthenticationServices
import BackgroundTasks
import CoreSpotlight
import SwiftUI
import SwiftData
import UIKit
import UserNotifications
import TalariaKit

final class TalariaAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(PendingActionNotificationCategory.all)
        // TAL-1488: a Deny a killed process left pending keeps the rest of its Undo window, then is sent.
        Task { @MainActor in await DeferredDenial.shared.resumePersisted() }
        // App-wide, so it lives here rather than in a window's view (TAL-2387).
        NotificationCenter.default.addObserver(
            forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                ConfigurationSyncCoordinator.shared.handleAppleCredentialRevoked()
                Task { await TalariaApp.invalidateRelayIdentity() }
            }
        }
        if UserDefaults.standard.bool(forKey: TalariaRelayNotifications.isEnabledKey)
            || UserDefaults.standard.bool(forKey: TalariaRelayNotifications.updateAvailableAlertsEnabledKey)
            || UserDefaults.standard.bool(forKey: ResponseCompletionNotifications.isEnabledKey) {
            application.registerForRemoteNotifications()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: TalariaRelayNotifications.pushTokenKey)
        Task { @MainActor in
            try? await TalariaAggregateLiveActivityManager.shared.refresh()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // The banner is the phone learning that a session finished, which is
        // sooner than the next polling tick would find out. Let the list adopt it
        // now so the row does not lag the notification the user just read.
        let namesASession = SessionNotificationRefresh.namesASession(userInfo: notification.request.content.userInfo)
        let visibleChats = await MainActor.run {
            if namesASession {
                NotificationCenter.default.post(name: .talariaSessionNotificationArrived, object: nil)
            }
            return SessionNotificationRefresh.visibleChats
        }

        return Self.foregroundPresentation(for: notification.request.content, visibleChats: visibleChats)
    }

    /// The chat on screen shows its own news and plays its own haptics, so its notifications stay silent (TAL-872).
    /// Quota alerts also go to Notification Center's list so they outlive the banner; other families keep theirs.
    nonisolated static func foregroundPresentation(
        for content: UNNotificationContent, visibleChats: Set<SessionNotificationRefresh.VisibleChat>
    ) -> UNNotificationPresentationOptions {
        if visibleChats.contains(where: { $0.isNamed(by: content.userInfo) }) { return [] }
        return content.categoryIdentifier == ProviderQuotaAlertSettings.categoryIdentifier
            ? [.banner, .sound, .list]
            : [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let url = Self.notificationURL(userInfo: userInfo)
        let answer = NotificationAnswer(
            actionIdentifier: response.actionIdentifier, userText: (response as? UNTextInputNotificationResponse)?.userText,
            userInfo: userInfo
        )
        // UIKit snapshots the app when this handler runs and asserts it is on main (TAL-2224).
        nonisolated(unsafe) let completionHandler = completionHandler
        Task { @MainActor in
            await Self.completeTap(opening: url, answering: answer, completion: completionHandler)
        }
    }

    nonisolated static func notificationURL(userInfo: [AnyHashable: Any]) -> URL? {
        if let session = SessionNotificationRefresh.sessionURL(userInfo: userInfo) { return session }
        guard userInfo[SessionNotificationRefresh.deepLinkKey] as? String == "/settings/system",
              let publisher = userInfo[SessionNotificationRefresh.publisherIDKey] as? String,
              let origin = TalariaRelayClient.originIdentifier(publisher)
        else { return nil }
        return TalariaDeepLink.sectionURL(.system, publisherID: origin)
    }

    /// Opens the tapped notification's destination, then completes the tap on the main actor. Allow, Deny and Reply answer
    /// in the background instead and open nothing (TAL-1469).
    @MainActor static func completeTap(
        opening url: URL?,
        answering answer: NotificationAnswer? = nil,
        with open: @MainActor (URL) async -> Void = { _ = await UIApplication.shared.open($0) },
        completion: () -> Void
    ) async {
        guard let answer else {
            if let url { await open(url) }
            return completion()
        }
        let task = UIApplication.shared.beginBackgroundTask(withName: "Answer from notification")
        await answer.respond()
        completion()
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }
}

struct TalariaSceneActions {
    let canCreateNewChat: Bool
    let createNewChat: () -> Void
    let searchSessions: () -> Void
}

private struct TalariaSceneActionsKey: FocusedValueKey {
    typealias Value = TalariaSceneActions
}

private struct TalariaFindInChatKey: FocusedValueKey {
    typealias Value = () -> Void
}

extension FocusedValues {
    var talariaSceneActions: TalariaSceneActions? {
        get { self[TalariaSceneActionsKey.self] }
        set { self[TalariaSceneActionsKey.self] = newValue }
    }

    var talariaFindInChat: (() -> Void)? {
        get { self[TalariaFindInChatKey.self] }
        set { self[TalariaFindInChatKey.self] = newValue }
    }
}

struct TalariaCommands: Commands {
    @FocusedValue(\.talariaSceneActions) private var actions
    @FocusedValue(\.talariaFindInChat) private var findInChat

    var body: some Commands {
        // iOS only materialises the group that replaces a standard one, so both commands
        // live here: an `after: .newItem` group never registered its key command.
        CommandGroup(replacing: .newItem) {
            Button("New Chat") {
                actions?.createNewChat()
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(actions?.canCreateNewChat != true)

            Button {
                if let findInChat { findInChat() }
                else { actions?.searchSessions() }
            } label: {
                if findInChat == nil { Text("Search Sessions") }
                else { Text("Find in Chat") }
            }
            .keyboardShortcut("f", modifiers: .command)
            .disabled(actions == nil && findInChat == nil)
        }
    }
}

@main
struct TalariaApp: App {
    static func openSessionActivity(_ activity: NSUserActivity, servers: [String], in router: AppIntentRouter) {
        let link: URL?
        switch activity.activityType {
        case CSSearchableItemActionType:
            let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
            link = identifier.flatMap { URL(string: $0) }
        case ChatHandoff.activityType:
            link = ChatHandoff.sessionURL(from: activity)
        default:
            return
        }
        guard let url = link, TalariaDeepLink.sessionID(from: url) != nil,
              let server = TalariaDeepLink.publisherID(from: url), servers.contains(server)
        else { return }
        router.requestDeepLink(url)
    }

    @UIApplicationDelegateAdaptor(TalariaAppDelegate.self) private var appDelegate
    @State private var authManager: AuthManager
    /// Read once per launch: an update's What's New waits here until the screen is free (TAL-182).
    @State private var whatsNew: WhatsNewPresenter
    /// One for every window, so each share is imported once and opens in one window (TAL-2387).
    @State private var sharedImports = SharedImportRouter()
    @State private var foregroundReturn = ForegroundReturnDetector()
    /// Aggregated across windows: active while any window is, background once all are (TAL-2387).
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppTheme.storageKey) private var appThemeRawValue = AppTheme.system.rawValue
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var isResponseCompletionNotificationsEnabled = false
    private let usesUITestFixture: Bool
    /// Offline session/message cache. Held explicitly (not just via the
    /// `modelContainer(for:)` modifier) so `AuthManager` can drop a server's
    /// cache when it is signed out or removed (TAL-146) or a sign-in reconciles
    /// to a different profile (TAL-131).
    private let cacheContainer: ModelContainer
    #if DEBUG
    private let uiTestFixture: UITestFixtureEnvironment?
    #endif

    init() {
        DisplayPhaseTrace.beginLaunch()
        PlatformBridges.install()
        AppConfig.logReleaseIdentity()
        let arguments = ProcessInfo.processInfo.arguments

        #if DEBUG
        let fixture = arguments.contains(UITestFixtureEnvironment.launchArgument)
            ? UITestFixtureEnvironment.make()
            : nil
        uiTestFixture = fixture
        usesUITestFixture = fixture != nil
        let indexesSpotlight = Bundle.main.bundleIdentifier?.hasSuffix(".xctest") != true
            || (usesUITestFixture && arguments.contains("--ui-test-spotlight"))
        #else
        usesUITestFixture = false
        let indexesSpotlight = true
        #endif
        if !usesUITestFixture { FeedbackDiagnosticStore.startCollection() }

        // Same store the `modelContainer(for:)` modifier would open; failure is
        // fatal there too. The offline cache is device-local: the CloudKit
        // entitlement (TAL-91 configuration sync) must not turn on SwiftData's
        // automatic mirroring, which also rejects the cache's unique keys.
        let cacheConfiguration = ModelConfiguration(isStoredInMemoryOnly: usesUITestFixture, cloudKitDatabase: .none)
        let cacheContainer = try! ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: cacheConfiguration
        )
        self.cacheContainer = cacheContainer
        if indexesSpotlight { CacheStore.enableSpotlight(in: cacheContainer) }
        let liveAuthManager = {
            AuthManager(
                resetServerScopedState: AuthManager.serverScopedStateReset(
                    cacheContainer: cacheContainer,
                    responseCacheRoot: ResponseCache.appRoot
                )
            )
        }
        #if DEBUG
        _authManager = State(initialValue: fixture?.authManager ?? liveAuthManager())
        #else
        _authManager = State(initialValue: liveAuthManager())
        #endif
        // A fixture launch starts from synthetic state, so it never offers this device's update.
        #if DEBUG
        _whatsNew = State(initialValue: WhatsNewPresenter(pending: usesUITestFixture ? nil : WhatsNewAnnouncement.pending()))
        #else
        _whatsNew = State(initialValue: WhatsNewPresenter(pending: WhatsNewAnnouncement.pending()))
        #endif

        // Registering only installs the launch handler, so the fixture needs it too: backgrounding
        // the app submits a refresh request from `appPhaseDidChange`, and submitting one whose
        // identifier was never registered aborts the process (TAL-77).
        ProviderQuotaBackgroundRefresh.register()
        if !usesUITestFixture {
            ProviderQuotaBackgroundRefresh.schedule()
        }

    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // Launch argument hook so the Streaming Lab can be opened without
            // UI navigation (agent-driven simulator diagnosis, issue #234):
            // `xcrun simctl launch <udid> dev.kil.talaria --streaming-lab`
            if ProcessInfo.processInfo.arguments.contains("--streaming-lab") {
                NavigationStack {
                    StreamingLabView()
                }
            } else if ProcessInfo.processInfo.arguments.contains("--provider-quota-widget-customization") {
                NavigationStack {
                    ProviderQuotaWidgetAppearanceView()
                }
            } else if ProcessInfo.processInfo.arguments.contains("--provider-quota-widget-fixture") {
                ProviderQuotaWidgetDebugFixtureView(writesSharedSnapshot: !usesUITestFixture)
            } else if ProcessInfo.processInfo.arguments.contains("--provider-quotas") {
                if let uiTestFixture {
                    NavigationStack {
                        InsightsView(
                            server: UITestFixtureEnvironment.serverURL,
                            quotaViewModel: ProvidersViewModel(
                                server: UITestFixtureEnvironment.serverURL,
                                client: uiTestFixture.client
                            ),
                            onAPIError: { _ in }
                        )
                    }
                } else if let rawServer = ServerRegistry.shared.activeServer?.urlString,
                          let server = URL(string: rawServer) {
                    NavigationStack {
                        InsightsView(server: server, onAPIError: { _ in })
                    }
                }
            } else {
                ContentView(
                    authManager: authManager,
                    draftStore: uiTestFixture?.draftStore,
                    whatsNew: whatsNew,
                    sharedImports: sharedImports
                )
                    .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
            }
            #else
            ContentView(authManager: authManager, whatsNew: whatsNew, sharedImports: sharedImports)
                .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
            #endif
        }
        .modelContainer(cacheContainer)
        .commands {
            TalariaCommands()
            SidebarCommands()
        }
        .onChange(of: scenePhase, initial: true) {
            appPhaseDidChange(scenePhase)
        }
    }
}

/// App-wide work, driven by the app's aggregate scene phase so it runs once however many windows are open
/// (TAL-2387). Each window's `ContentView` keeps only its own routing and presentation.
extension TalariaApp {
    private func appPhaseDidChange(_ phase: ScenePhase) {
        if phase != .active {
            // Save identity edits still waiting on their typing pause (TAL-123).
            authManager.flushServerIdentityEdits()
        }
        if phase == .background {
            ProviderQuotaBackgroundRefresh.schedule()
        }
        guard let activation = foregroundReturn.activation(on: phase) else { return }
        if activation == .foreground(returned: true) {
            // Every server-backed screen refreshes through `refreshesLive` (TAL-435).
            NotificationCenter.default.post(name: .talariaReturnedToForeground, object: nil)
        }
        if activation == .launch {
            ConfigurationSyncCoordinator.shared.attach(authManager: authManager)
        }
        try? CacheStore.maintainCache(in: cacheContainer.mainContext)
        Task {
            guard !AppLockModel.shared.isLocked else { return }
            await sharedImports.importIfAvailable()
        }
        // #246: the launch pass ends any Live Activity left "running" by a run that finished while the app was
        // terminated, and #248 lets only it fire a recent run's "response complete" notification, since a relaunch
        // means it finished while not active. Later passes stay silent: the in-session completion paths own
        // notifications while the app is alive.
        Task { await reconcileOrphanedLiveActivities(notifiesOnCompletion: activation == .launch) }
        Task { await Self.refreshRelayIdentityAndActivity() }
        Task { await ConfigurationSyncCoordinator.shared.refreshOnForeground() }
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

    private static func refreshRelayIdentityAndActivity() async {
        guard let credentials = TalariaRelayConfigurationStore.load() else { return }
        if credentials.pendingRevocation == true {
            do {
                try await TalariaAggregateLiveActivityManager.shared.disconnect()
                try await TalariaRelayClient(credentials: credentials).revokeSession()
                try TalariaRelayConfigurationStore.clear()
            } catch {}
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

    static func invalidateRelayIdentity() async {
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
}

@MainActor
enum ProviderQuotaBackgroundRefresh {
    static var identifier: String {
        "\(Bundle.main.bundleIdentifier ?? "dev.kil.talaria").provider-quota-refresh"
    }

    /// `BGTaskScheduler.submit` raises — and so aborts the process — when the
    /// identifier was never registered, and the UI-test fixture deliberately
    /// registers nothing. Backgrounding it used to crash the app through
    /// `ContentView`'s scene-phase hook (TAL-75).
    private static var isRegistered = false

    static func register() {
        isRegistered = true
        // `.main`: this main-actor closure would trap on the scheduler's default background queue.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            Task { @MainActor in
                guard let refreshTask = task as? BGAppRefreshTask else {
                    task.setTaskCompleted(success: false)
                    return
                }
                handle(refreshTask)
            }
        }
    }

    static func schedule() {
        guard isRegistered,
              let credentials = ProviderQuotaWidgetRefreshCredentialStore.load() else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        try? BGTaskScheduler.shared.submit(request(credentials: credentials, now: Date()))
    }

    static func request(
        credentials: ProviderQuotaWidgetRefreshCredentials,
        now: Date
    ) -> BGAppRefreshTaskRequest {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(
            timeInterval: TimeInterval(max(credentials.refreshIntervalSeconds, 60)),
            since: now
        )
        return request
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        let operation = Task {
            await ProviderQuotaWidgetRefreshClient.refreshFromSharedCredentials()
        }
        task.expirationHandler = {
            operation.cancel()
        }
        Task {
            task.setTaskCompleted(success: await operation.value)
        }
    }
}

#if DEBUG
private struct ProviderQuotaWidgetDebugFixtureView: View {
    let writesSharedSnapshot: Bool
    @State private var isReady = false

    var body: some View {
        ContentUnavailableView(
            isReady ? "Widget fixture ready" : "Preparing widget fixture",
            systemImage: "gauge.with.dots.needle.33percent",
            description: Text("Add or edit the Talaria Provider quotas widget to inspect its configured states.")
        )
        .task {
            guard writesSharedSnapshot else {
                isReady = true
                return
            }
            let sources = [
                fixtureSource(id: "fixture-work", provider: "Codex", account: "Work", used: 24),
                fixtureSource(id: "fixture-personal", provider: "Codex", account: "Personal", used: 61),
                fixtureSource(id: "fixture-openrouter", provider: "OpenRouter", account: "Credits", used: 78),
                fixtureSource(id: "fixture-anthropic", provider: "Anthropic", account: "Team", used: 42),
            ]
            isReady = ProviderQuotaWidgetSnapshotStore().save(
                scopeID: "qscope_fixture",
                sources: sources
            )
            ProviderQuotaWidgetSnapshotStore.reloadTimelines()
        }
    }

    private func fixtureSource(
        id: String,
        provider: String,
        account: String,
        used: Double
    ) -> ProviderQuotaWidgetSource {
        ProviderQuotaWidgetSource(
            sourceID: id,
            scopeID: "qscope_fixture",
            scopeLabel: "Fixture · default",
            providerLabel: provider,
            accountLabel: account,
            isActiveProvider: id == "fixture-work",
            status: "available",
            plan: "Pro",
            windows: [
                ProviderQuotaWindow(label: "Session", usedPercent: used, remainingPercent: 100 - used),
                ProviderQuotaWindow(label: "Weekly", usedPercent: min(used + 12, 100), remainingPercent: max(88 - used, 0)),
            ],
            retryAfter: nil,
            fetchedAt: ISO8601DateFormatter().string(from: Date()),
            paceWindowIndex: 1,
            sessionWindowIndex: 0,
            weeklyWindowIndex: 1
        )
    }
}
#endif

extension ResponseCache {
    /// The app's response cache for `server` (TAL-437). UI-test fixture launches use a scratch
    /// directory, so no journey sees another's cached responses.
    static func app(server: URL) -> ResponseCache {
        ResponseCache(server: server, root: appRoot)
    }

    /// nil selects the Caches directory; the sign-out reset clears the same root.
    static var appRoot: URL? {
        #if DEBUG
        UITestFixtureEnvironment.responseCacheRoot
        #else
        nil
        #endif
    }
}
