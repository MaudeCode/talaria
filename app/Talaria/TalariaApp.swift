import BackgroundTasks
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
        if UserDefaults.standard.bool(forKey: TalariaRelayNotifications.isEnabledKey)
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

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // The banner is the phone learning that a session finished, which is
        // sooner than the next polling tick would find out. Let the list adopt it
        // now so the row does not lag the notification the user just read.
        if SessionNotificationRefresh.namesASession(
            userInfo: notification.request.content.userInfo
        ) {
            NotificationCenter.default.post(name: .talariaSessionNotificationArrived, object: nil)
        }

        return [.banner, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let sessionID = userInfo[SessionNotificationRefresh.sessionIDKey] as? String,
              let url = TalariaDeepLink.sessionURL(
                sessionID: sessionID,
                publisherID: userInfo["publisherId"] as? String
              )
        else { return }
        await UIApplication.shared.open(url)
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

extension FocusedValues {
    var talariaSceneActions: TalariaSceneActions? {
        get { self[TalariaSceneActionsKey.self] }
        set { self[TalariaSceneActionsKey.self] = newValue }
    }
}

struct TalariaCommands: Commands {
    @FocusedValue(\.talariaSceneActions) private var actions

    var body: some Commands {
        // iOS only materialises the group that replaces a standard one, so both commands
        // live here: an `after: .newItem` group never registered its key command.
        CommandGroup(replacing: .newItem) {
            Button("New Chat") {
                actions?.createNewChat()
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(actions?.canCreateNewChat != true)

            Button("Search Sessions") {
                actions?.searchSessions()
            }
            .keyboardShortcut("f", modifiers: .command)
            .disabled(actions == nil)
        }
    }
}

@main
struct TalariaApp: App {
    @UIApplicationDelegateAdaptor(TalariaAppDelegate.self) private var appDelegate
    @State private var authManager: AuthManager
    @AppStorage(AppTheme.storageKey) private var appThemeRawValue = AppTheme.system.rawValue
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
        PlatformBridges.install()
        AppConfig.logReleaseIdentity()
        let arguments = ProcessInfo.processInfo.arguments

        #if DEBUG
        if ShareExtensionUITestHost.resetsSharedState {
            ShareExtensionUITestHost.resetSharedState()
        }
        ShareOpenFixtureMode.storeHoldsStatus(ShareExtensionUITestHost.isActive)
        let fixture = arguments.contains(UITestFixtureEnvironment.launchArgument)
            ? UITestFixtureEnvironment.make()
            : nil
        uiTestFixture = fixture
        usesUITestFixture = fixture != nil
        #else
        usesUITestFixture = false
        #endif

        // Same store the `modelContainer(for:)` modifier would open; failure is
        // fatal there too. The offline cache is device-local: the CloudKit
        // entitlement (TAL-91 configuration sync) must not turn on SwiftData's
        // automatic mirroring, which also rejects the cache's unique keys.
        var cacheConfiguration = ModelConfiguration(isStoredInMemoryOnly: usesUITestFixture, cloudKitDatabase: .none)
        #if DEBUG
        if usesUITestFixture, let storeURL = UITestFixtureEnvironment.persistentCacheStoreURL {
            cacheConfiguration = ModelConfiguration(url: storeURL, cloudKitDatabase: .none)
        }
        #endif
        let cacheContainer = try! ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: cacheConfiguration
        )
        self.cacheContainer = cacheContainer
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

        // Registering only installs the launch handler, so the fixture needs it too: backgrounding
        // the app submits a refresh request from `ContentView`, and submitting one whose
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
                    draftStore: uiTestFixture?.draftStore
                )
                    .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
                    // TAL-81: overlaid rather than a root of its own, so the share
                    // extension's `talaria://share` open lands on the real import path.
                    .overlay(alignment: .top) {
                        if ShareExtensionUITestHost.isActive {
                            ShareExtensionUITestHostBar()
                        }
                    }
            }
            #else
            ContentView(authManager: authManager)
                .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
            #endif
        }
        .modelContainer(cacheContainer)
        .commands {
            TalariaCommands()
            SidebarCommands()
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
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
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
            fetchedAt: ISO8601DateFormatter().string(from: Date())
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
