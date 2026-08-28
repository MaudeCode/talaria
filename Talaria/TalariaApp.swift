import BackgroundTasks
import SwiftUI
import SwiftData

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
        CommandGroup(replacing: .newItem) {
            Button("New Chat") {
                actions?.createNewChat()
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(actions?.canCreateNewChat != true)
        }

        CommandGroup(after: .newItem) {
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
    @State private var authManager: AuthManager
    @AppStorage(AppTheme.storageKey) private var appThemeRawValue = AppTheme.system.rawValue
    private let usesUITestFixture: Bool
    #if DEBUG
    private let uiTestFixture: UITestFixtureEnvironment?
    #endif

    init() {
        let arguments = ProcessInfo.processInfo.arguments

        #if DEBUG
        let fixture = arguments.contains(UITestFixtureEnvironment.launchArgument)
            ? UITestFixtureEnvironment.make()
            : nil
        uiTestFixture = fixture
        usesUITestFixture = fixture != nil
        _authManager = State(initialValue: fixture?.authManager ?? AuthManager())
        #else
        usesUITestFixture = false
        _authManager = State(initialValue: AuthManager())
        #endif

        if !usesUITestFixture {
            ProviderQuotaBackgroundRefresh.register()
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
            }
            #else
            ContentView(authManager: authManager)
                .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
            #endif
        }
        .modelContainer(
            for: [CachedSession.self, CachedMessage.self],
            inMemory: usesUITestFixture
        )
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

    static func register() {
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
        guard let credentials = ProviderQuotaWidgetRefreshCredentialStore.load() else { return }
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
