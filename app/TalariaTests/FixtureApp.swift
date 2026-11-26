import SwiftData
import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// A hosted test's fixture arguments, appended to what `ProcessInfo.arguments` returns: the fixture checks in App and
/// TalariaKit code read the launch arguments directly, so the tests change those rather than the checks.
enum FixtureLaunchArguments {
    nonisolated(unsafe) static var scenario: [String] = [] {
        willSet { _ = installed }
    }

    private static let installed: Void = {
        // Swift reads go to the runtime subclass's override (`_NSSwiftProcessInfo`), not to NSProcessInfo's getter.
        let selector = #selector(getter: ProcessInfo.arguments)
        guard let type = object_getClass(ProcessInfo.processInfo),
              let method = class_getInstanceMethod(type, selector) else {
            preconditionFailure("ProcessInfo has no arguments getter")
        }
        typealias Getter = @convention(c) (AnyObject, Selector) -> NSArray
        let original = unsafeBitCast(method_getImplementation(method), to: Getter.self)
        let arguments: @convention(block) (AnyObject) -> NSArray = { info in
            original(info, selector).addingObjects(from: scenario) as NSArray
        }
        let replacement = imp_implementationWithBlock(arguments)
        if !class_addMethod(type, selector, replacement, method_getTypeEncoding(method)) {
            method_setImplementation(method, replacement)
        }
    }()
}

/// The App's UI-test fixture, started in process for one hosted test (TAL-856): the same canned server, sessions and
/// scenarios the UI tests launched with arguments, chosen per test instead: `FixtureLaunchArguments` adds them to the
/// process's launch arguments, which every fixture check reads, until teardown.
/// A test hosts the App's screens against it with one offline cache, so a second host sees what the first one cached,
/// the way a reopen or relaunch does.
@MainActor
@Observable
final class FixtureApp {
    let environment: UITestFixtureEnvironment
    /// Released by `tearDown()`, once no work that could reach it is left.
    @ObservationIgnored private(set) var cache: ModelContainer!
    var pendingSessionID: String?
    var pendingBotChat: TalariaDeepLink.BotChat?
    var requestedNewChat: NewChatRequest?
    var opensQuotaWidgetSettings = false
    var pendingDestination: SessionListUtilityDestination?
    /// Every chat and session list made since this fixture started: their async work reads and writes the cache, so
    /// teardown waits until none has any admitted (TAL-1097).
    @ObservationIgnored private let cacheOwners = NSHashTable<AnyObject>.weakObjects()
    @ObservationIgnored private weak var testCase: XCTestCase?
    /// Fixtures not yet torn down; the warm-up, whose teardown blocks never run, tears its own down through it.
    private static var open: [FixtureApp] = []
    nonisolated(unsafe) private static var busyCacheKey: UInt8 = 0

    var client: APIClient { environment.client }

    /// `configured: false` starts the App with no saved server, on onboarding.
    init(_ scenario: [String] = [], configured: Bool = true, for testCase: XCTestCase) throws {
        FixtureLaunchArguments.scenario = [UITestFixtureLaunch.launchArgument] + scenario
        UITestFixtureURLProtocol.resetForHostedTest()
        // A relaunch empties what a process keeps in memory per session; hosted tests share one process.
        ActiveChatStreamSnapshotStore.shared.removeAll(for: UITestFixtureEnvironment.serverURL)
        ChatViewModel.forgetCompanionPages()
        environment = UITestFixtureEnvironment.make(configured: configured)
        // Each hosted journey owns its sidebar choices; a second window within it still exercises persistence.
        for key in ["settings.modelPicker.collapsedProviders", SessionSidebarDisclosureSettings.regularPortraitVisibilityKey,
                    SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey,
                    SessionNavigationPersistence.key(for: UITestFixtureEnvironment.serverURL),
                    SessionNavigationPersistence.key(for: UITestFixtureEnvironment.secondServerURL)] {
            UserDefaults.standard.removeObject(forKey: key)
        }
        cache = try ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        self.testCase = testCase
        UITestCacheOwnerHook.created = { [weak self] in self?.cacheOwners.add($0) }
        Self.open.append(self)
        // The block holds the fixture, and so its cache, until its work has ended, whether the test passed, failed or threw.
        testCase.addTeardownBlock { @MainActor in await self.tearDown() }
    }

    /// Ends this fixture's work before its cache goes (TAL-1097). SwiftData traps on a context whose container is gone,
    /// so teardown takes down every hosted window while the cache is still there, stops admitting the fixture's loads
    /// and fails those still open, held loads and streams included, then waits until no chat or session list made under
    /// it has cache work admitted: a chat still shown has yet to write its transcript as its screen leaves, which it does
    /// a turn later, and a queued list reload, which cancelling its screen does not cancel, ends with the load it
    /// awaited. Only then do the scenario, the fixture's server state and the cache go. The test's teardown runs it;
    /// a test that checks the drain itself calls it first.
    func tearDown() async {
        guard let cache else { return }
        HostedScene.dismantleWindows()
        UITestFixtureURLProtocol.cancelOpenLoads()
        UITestFixtureHold.shared.release()
        let busy = { self.cacheOwners.allObjects.compactMap { $0 as? any UITestCacheOwner }.filter(\.hasCacheWorkInFlight) }
        let drained = await testCase?.awaitCondition { busy().isEmpty } ?? false
        if !drained {
            let owners = busy()
            XCTFail("Cache work outlived its fixture's teardown: \(owners.map { String(describing: type(of: $0)) })")
            // Each keeps the cache its work can still reach, so the failure stays this test's instead of a later trap.
            for owner in owners { objc_setAssociatedObject(owner, &Self.busyCacheKey, cache, .OBJC_ASSOCIATION_RETAIN) }
        }
        FixtureLaunchArguments.scenario = []
        UITestFixtureURLProtocol.resetForHostedTest()
        Self.open.removeAll { $0 === self }
        self.cache = nil
    }

    /// Tears down every fixture still open, newest first.
    static func tearDownOpenFixtures() async {
        for fixture in open.reversed() { await fixture.tearDown() }
    }

    /// Entry opens at the latest row; older fixture rows may be unmounted by lazy layout.
    static func isLoadedTranscriptRow(_ element: NSObject) -> Bool {
        element.accessibilityLabel?.hasPrefix("Fixture message 48 ") == true
    }

    /// Answers every load the scenario held, as the UI tests' `releaseHeldLoads` did.
    func releaseHeldLoads() {
        UITestFixtureHold.shared.release()
    }

    func session(_ sessionID: String = UITestFixtureURLProtocol.sessionID) async throws -> SessionSummary {
        let sessions = try await client.sessions().sessions ?? []
        return try XCTUnwrap(sessions.first { $0.sessionId == sessionID }, "The fixture lists no \(sessionID)")
    }

    /// Pushes the chat as the session list does; pure canvas fixtures can omit the navigation container.
    func chat(_ session: SessionSummary, viewModel: ChatViewModel? = nil,
              asNavigationDestination: Bool = true, initialDraft: String? = nil,
              loadsInitialMessages: Bool = true) -> some View {
        // Fixture streams run in process, so a real device's offline path must not block their restoration.
        let viewModel = viewModel ?? ChatViewModel(session: session, server: UITestFixtureEnvironment.serverURL,
                                                  client: client, networkPath: nil)
        let chat = ChatView(
            session: session,
            server: UITestFixtureEnvironment.serverURL,
            onAPIError: { _ in },
            initialDraft: initialDraft,
            loadsInitialMessages: loadsInitialMessages,
            draftStore: self.environment.draftStore,
            viewModel: viewModel
        )
        return Group {
            if asNavigationDestination {
                NavigationStack {
                    Color.clear.navigationDestination(isPresented: .constant(true)) { chat }
                }
            } else {
                chat
            }
        }
        // A window outside SwiftUI's scene lifecycle reports no scene phase of its own; the App's runs in the foreground.
        .environment(\.scenePhase, .active)
        .modelContainer(cache)
    }

    /// The App's root, whose auth state picks onboarding or the session list, as a launch does.
    func root(intentRouter: AppIntentRouter = AppIntentRouter()) -> some View {
        // Its own router: the test host's ContentView drains the shared one.
        ContentView(authManager: environment.authManager, draftStore: environment.draftStore, intentRouter: intentRouter)
            .environment(\.scenePhase, .active)
            .modelContainer(cache)
    }

    func sessionList(scenePhase: ScenePhase = .active, chats: ChatViewModelCache? = nil,
                     viewModel: SessionListViewModel? = nil, hasWaitingSharedImport: Bool = false,
                     openNextSharedImport: @escaping () -> Void = {}) -> some View {
        SessionListView(
            authManager: environment.authManager,
            server: UITestFixtureEnvironment.serverURL,
            modelContext: cache.mainContext,
            hasWaitingSharedImport: hasWaitingSharedImport,
            openNextSharedImport: openNextSharedImport,
            pendingDeepLinkedSessionID: Binding(get: { self.pendingSessionID }, set: { self.pendingSessionID = $0 }),
            pendingBotChat: Binding(get: { self.pendingBotChat }, set: { self.pendingBotChat = $0 }),
            pendingDestination: Binding(get: { self.pendingDestination }, set: { self.pendingDestination = $0 }),
            opensProviderQuotaWidgetSettings: Binding(get: { self.opensQuotaWidgetSettings }, set: { self.opensQuotaWidgetSettings = $0 }),
            requestedNewChat: Binding(get: { self.requestedNewChat }, set: { self.requestedNewChat = $0 }),
            draftStore: environment.draftStore,
            chats: chats,
            viewModel: viewModel
        )
        .environment(\.scenePhase, scenePhase)
        .modelContainer(cache)
    }
}

/// A navigation stack whose button pushes `destination` the way a row pushes a chat.
struct FixturePushHost<Content: View>: View {
    let destination: Content
    @State private var isPresented = false
    var body: some View {
        NavigationStack {
            Button("Open fixture chat") { isPresented = true }
                .navigationDestination(isPresented: $isPresented) { destination }
        }
    }
}

/// A process's first chat render takes 20 to 50 s on a hosted runner, against about 3 s for the next: the Swift runtime
/// resolves the generic conformances SwiftUI asks for by scanning every loaded image. Its first Markdown transcript and
/// keyboard add up to 40 s more, past the 10 s waits of whichever test comes first. A chat opened from the Chats list
/// then draws with a render pipeline the bare chat does not use; the runner compiles it on the main thread, which held
/// the screen for 9 s (TAL-2275). The first animated push does one-time main-thread work no still draw does: up to 4 s
/// of main-thread CPU on a Mac after a fresh build, and the composer-push test's push took 9 s on a runner, 28 s under
/// load (TAL-2543). They belong to the run, so they happen before any test starts (TAL-1891). The bundle's principal
/// class.
@objc(HostedTestBundle)
final class HostedTestBundle: NSObject, XCTestObservation {
    override init() {
        super.init()
        XCTestObservationCenter.shared.addTestObserver(self)
    }

    func testBundleWillStart(_ testBundle: Bundle) {
        MainActor.assumeIsolated {
            var finished = false
            // No test is running, so its teardown blocks never run; its fixtures are torn down below.
            let warmer = XCTestCase()
            Task { @MainActor in
                if let window = try? await warmer.hostFixtureChat(["--ui-test-long-bodies"]) {
                    _ = await warmer.awaitElement(in: window, label: "Short reply 25.", timeout: 60)
                    if let composer = await warmer.composerTextView(in: window) {
                        composer.becomeFirstResponder()
                        composer.resignFirstResponder()
                    }
                    window.isHidden = true
                }
                if let fixture = try? FixtureApp(for: warmer), let window = try? warmer.hostWindow(fixture.sessionList()) {
                    try? await warmer.openSidebar(in: window)
                    if let row = await warmer.awaitElement(in: window, timeout: 60, where: {
                        $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
                    }), HostedAccessibility.activate(row) {
                        _ = await warmer.awaitElement(in: window, timeout: 60, where: FixtureApp.isLoadedTranscriptRow)
                    }
                }
                // The companion page beside a chat drew for the first time inside whichever companion test came first on the
                // native Duo shard, about 2 s on a runner, which put a 20 s test over its target (TAL-2712). The settled
                // turn shows it without a send.
                if #available(iOS 27.1, *),
                   let fixture = try? FixtureApp(["--ui-test-chat-companion", UITestFixtureEnvironment.companionFocusArgument,
                                                  UITestFixtureEnvironment.companionTurnArgument], for: warmer),
                   let window = try? warmer.hostWindow(fixture.sessionList(), size: HostedSize.duoInnerLandscape, traits: {
                       $0.horizontalSizeClass = .regular
                       $0.verticalSizeClass = .regular
                   }) {
                    try? await warmer.openSidebar(in: window)
                    if let row = await warmer.awaitElement(in: window, timeout: 60, where: {
                        $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
                    }), HostedAccessibility.activate(row) {
                        let files = Set(UITestFixtureURLProtocol.companionFiles.map { ($0 as NSString).lastPathComponent })
                        _ = await warmer.awaitElement(in: window, timeout: 60, where: {
                            files.contains($0.accessibilityLabel ?? "") && $0.accessibilityTraits.contains(.header)
                        })
                    }
                }
                if let fixture = try? FixtureApp(for: warmer), let session = try? await fixture.session() {
                    var pushed = false
                    let chat = fixture.chat(session, asNavigationDestination: false)
                        .background(NavigationAppearanceCompletionObserver { pushed = true })
                    if let window = try? warmer.hostWindow(FixturePushHost(destination: chat), animationsEnabled: true),
                       let scene = window.windowScene {
                        if let open = await warmer.awaitElement(in: window, label: "Open fixture chat", timeout: 60) {
                            await warmer.awaitDisplayUpdates(2, in: scene)
                            HostedAccessibility.activate(open)
                            _ = await warmer.awaitCondition(timeout: 60) { pushed }
                        }
                    }
                }
                // The auxiliary picker has a different SwiftUI body specialization from Default Model.
                // Its first push can spend the hosted test's allowance rendering that body.
                if let fixture = try? FixtureApp(for: warmer), let window = try? warmer.hostWindow(NavigationStack {
                    AuxiliaryModelsSettingsView(server: UITestFixtureEnvironment.serverURL)
                        .environment(fixture.environment.authManager)
                }) {
                    if let vision = await warmer.awaitElement(in: window, where: { $0.accessibilityLabel?.hasPrefix("Vision") == true }),
                       HostedAccessibility.activate(vision),
                       let model = await warmer.awaitElement(in: window, where: {
                           HostedAccessibility.identifier(of: $0) == "auxiliary-edit-model"
                       }), HostedAccessibility.activate(model) {
                        _ = await warmer.awaitElement(in: window, where: {
                            HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-model"
                        })
                    }
                }
                // Settings, its iPad layout and its search field drew for the first time inside whichever Settings test came
                // first: 16 to 38 s per size on a runner against about 3 s locally or after another Settings test (TAL-2405).
                for size in [HostedSize.phone, HostedSize.padLandscape] {
                    guard let fixture = try? FixtureApp(for: warmer),
                          let window = try? warmer.hostWindow(fixture.sessionList(), size: size) else { continue }
                    try? await warmer.openSidebar(in: window)
                    _ = await warmer.awaitCondition(timeout: 60) { warmer.settingsAvatar(in: window) != nil }
                    guard let avatar = warmer.settingsAvatar(in: window), HostedAccessibility.activate(avatar) else { continue }
                    _ = await warmer.awaitCondition(timeout: 60) { warmer.settingsSearchButton(in: window) != nil }
                    guard let search = warmer.settingsSearchButton(in: window), HostedAccessibility.activate(search) else { continue }
                    _ = await warmer.awaitCondition(timeout: 60) { window.firstView(ofType: UITextField.self)?.isFirstResponder == true }
                    window.firstView(ofType: UITextField.self)?.resignFirstResponder()
                }
                await FixtureApp.tearDownOpenFixtures()
                finished = true
            }
            // No test starts before the warm-up ends, however long a loaded host takes; each step has its own bounded
            // waits. A warm-up left running opened its next FixtureApp mid-test, whose reset cancelled that test's
            // requests, and its assertions failed whichever test was running (TAL-2688).
            while !finished { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
            UIView.setAnimationsEnabled(true)
        }
    }
}

extension ChatScrollPositionController {
    /// No navigation, row realization or position preservation (a disclosure hold or a prepend's measurement window)
    /// is running. Until then the controller owns the offset, and puts back a raw `contentOffset` write that is not a
    /// drag as its own re-anchoring, so a synthetic scroll or fixture interaction waits for this (TAL-2719).
    var isIdle: Bool { !isNavigating && !isPreservingPosition && !isRealizingRows }
}

/// The last text a Copy action copied while `recordCopies()` held the copy hook.
@MainActor
final class CopiedText {
    var last: String?
}

extension XCTestCase {
    /// The fixture's chat in its own window: the hosted counterpart of a UI test that launched with `scenario` and
    /// tapped the fixture session.
    @MainActor
    func hostFixtureChat(
        _ scenario: [String] = [],
        sessionID: String = UITestFixtureURLProtocol.sessionID,
        size: CGSize = HostedSize.phone,
        traits: (inout UITraitOverrides) -> Void = { _ in }
    ) async throws -> UIWindow {
        let fixture = try FixtureApp(scenario, for: self)
        return try hostWindow(fixture.chat(try await fixture.session(sessionID)), size: size, traits: traits)
    }

    @MainActor
    func attachHistoryImage(_ window: UIWindow, name: String) {
        attachHostedScreenshot(window, name: name)
    }

    /// Opens the one shared panel, whether the window uses a tiled column or an overlay drawer.
    @MainActor
    func openSidebar(in window: UIWindow, file: StaticString = #filePath, line: UInt = #line) async throws {
        func isOpen() -> Bool {
            if let split = HostedAccessibility.splitViewController(under: window.rootViewController),
               split.displayMode == .oneBesideSecondary { return true }
            return HostedAccessibility.element(in: window, label: "Close navigation") != nil
        }
        let regular = window.traitCollection.horizontalSizeClass == .regular
        let title = regular ? "Sidebar" : "Open navigation"
        // Wait for layout admission, not the provisional root's toolbar. A forced book column needs no toggle.
        let available = await awaitCondition {
            if isOpen() { return true }
            guard let host = window.rootViewController?.firstDescendant(ofType: AppSidebarController.self) else { return false }
            if regular, SidebarPresentation(isRegularWidth: true, splitSize: window.bounds.size,
                                            hasVerticalBar: false, storedChoice: false).tiled, host.isEnabled { return false }
            return HostedAccessibility.toolbarItem(title, in: window) != nil
        }
        XCTAssertTrue(available, "The sidebar presentation never became available", file: file, line: line)
        if isOpen() { return }
        let control = window.firstView(ofType: UIControl.self, where: { $0.accessibilityLabel == title })
        if let control {
            XCTAssertTrue(HostedAccessibility.activate(control), "The native sidebar action did not run", file: file, line: line)
        } else {
            let item = try XCTUnwrap(HostedAccessibility.toolbarItem(title, in: window), file: file, line: line)
            XCTAssertTrue(HostedAccessibility.activate(item), "The native sidebar action did not run", file: file, line: line)
        }
        let opened = await awaitCondition { isOpen() }
        XCTAssertTrue(opened, "The sidebar did not open", file: file, line: line)
    }

    /// Waits for an element that satisfies `match` to appear in `window`'s accessibility tree. It sleeps between looks
    /// rather than spinning the run loop, so the screen's own main-actor tasks run meanwhile.
    @MainActor
    func awaitElement(
        in window: UIWindow,
        timeout: TimeInterval = 10,
        where match: @escaping (NSObject) -> Bool
    ) async -> NSObject? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let found = HostedAccessibility.elements(in: window).first(where: match) { return found }
            try? await Task.sleep(for: .milliseconds(50))
        }
        if let found = HostedAccessibility.elements(in: window).first(where: match) { return found }
        let labels = XCTAttachment(string: HostedAccessibility.labels(in: window).joined(separator: "\n"))
        labels.name = "accessibility labels at the miss"
        labels.lifetime = .deleteOnSuccess
        add(labels)
        return nil
    }

    @MainActor
    func awaitElement(in window: UIWindow, label: String, timeout: TimeInterval = 10) async -> NSObject? {
        await awaitElement(in: window, timeout: timeout) { $0.accessibilityLabel == label }
    }

    /// `awaitElement(in:label:)` that fails the test with `message` when the element never appears.
    @MainActor
    func requireElement(
        in window: UIWindow,
        label: String,
        _ message: String = "",
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> NSObject {
        let found = await awaitElement(in: window, label: label)
        return try XCTUnwrap(found, message.isEmpty ? "Missing \(label)" : message, file: file, line: line)
    }

    /// Waits until no element satisfies `match`, and reports whether it went.
    @MainActor
    func awaitNoElement(
        in window: UIWindow,
        timeout: TimeInterval = 10,
        where match: @escaping (NSObject) -> Bool
    ) async -> Bool {
        await awaitCondition(timeout: timeout) { !HostedAccessibility.elements(in: window).contains(where: match) }
    }

    /// The controller presented on top of the window's root, once there is one.
    @MainActor
    func presentedController(in window: UIWindow, timeout: TimeInterval = 5) async -> UIViewController? {
        func top() -> UIViewController? {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller === window.rootViewController ? nil : controller
        }
        _ = await awaitCondition(timeout: timeout) { top() != nil }
        return top()
    }

    /// The alert presented on top of the window's root, once there is one.
    @MainActor
    func presentedAlert(in window: UIWindow, timeout: TimeInterval = 5) async -> UIAlertController? {
        await presentedController(in: window, timeout: timeout) as? UIAlertController
    }

    /// Waits for `condition` without blocking the main actor the screen's tasks run on, and reports whether it held.
    @MainActor
    func awaitCondition(timeout: TimeInterval = 10, _ condition: @escaping () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    /// Answers the held request once it has reached the fixture. An optimistic write changes the screen first and
    /// URLSession starts its request after, and a release lands only on loads already held (TAL-2547).
    @MainActor
    func releaseHeldRequest(of fixture: FixtureApp, file: StaticString = #filePath, line: UInt = #line) async {
        let held = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
        XCTAssertTrue(held, "The request never reached the fixture", file: file, line: line)
        fixture.releaseHeldLoads()
    }

    /// Waits until no transcript row has realized for 500 ms and returns the settled count, or nil if rows kept
    /// realizing. Lazy layout can shift the mounted window once more after startup, especially on CI (TAL-1544).
    @MainActor
    func awaitQuietRowRealization(_ rows: ChatTranscriptRowCache) async -> Int? {
        await awaitQuiet { rows.realizationCount }
    }

    /// Waits until `current()` has not changed for 500 ms and returns its settled value, or nil if it kept changing.
    /// On a loaded runner, late layout passes land well after the work that queued them (TAL-1544, TAL-1570).
    @MainActor
    func awaitQuiet<Value: Equatable>(_ current: @escaping () -> Value) async -> Value? {
        var value = current()
        let clock = ContinuousClock()
        var lastChange = clock.now
        let settled = await awaitCondition {
            if current() != value {
                value = current()
                lastChange = clock.now
            }
            return clock.now - lastChange >= .milliseconds(500)
        }
        return settled ? value : nil
    }

    /// Waits until `recorder` has counted no chat work for 500 ms. Otherwise it fails naming `phase` and the work each
    /// of the last changes added, so a timeout says which view kept re-evaluating, and when (TAL-2273).
    @MainActor
    func awaitQuietWork(of recorder: ChatBodyEvaluationRecorder, phase: String,
                        file: StaticString = #filePath, line: UInt = #line) async {
        let clock = ContinuousClock()
        let start = clock.now
        var changes: [(at: Duration, counts: [String: Int])] = [(.zero, recorder.counts)]
        let quiet = await awaitQuiet { () -> [String: Int] in
            let counts = recorder.counts
            if counts != changes.last?.counts { changes = Array((changes + [(clock.now - start, counts)]).suffix(6)) }
            return counts
        }
        guard quiet == nil else { return }
        let report = zip(changes, changes.dropFirst()).map { before, after in
            let added = after.counts.compactMap { key, count in
                let delta = count - before.counts[key, default: 0]
                return delta == 0 ? nil : "\(key)+\(delta)"
            }.sorted().joined(separator: " ")
            return "\(Int(after.at / .milliseconds(1))) ms: \(added)"
        }.joined(separator: "; ")
        XCTFail("\(phase): the chat kept re-evaluating through the wait. Last changes: \(report)", file: file, line: line)
    }

    /// The composer as the window draws it: its editor, or the collapsed "Message" shell an unfocused empty composer
    /// shows in its place, which has no text view (TAL-2695).
    @MainActor
    func composerFrame(in window: UIWindow) -> CGRect? {
        window.firstView(ofType: ComposerTextView.PastingTextView.self) { !$0.isHidden }.map { $0.convert($0.bounds, to: window) }
            ?? HostedAccessibility.element(in: window, label: "Message")?.accessibilityFrame
    }

    /// Reads either composer presentation; a missing composer is not an empty draft.
    @MainActor
    func composerDraftText(in window: UIWindow) -> String? {
        if let input = window.firstView(ofType: ComposerTextView.PastingTextView.self) {
            return input.text
        }
        return HostedAccessibility.element(in: window, label: "Message") == nil ? nil : ""
    }

    /// The chat composer's text view, once the chat has one. `timeout` counts the helper's own 50 ms polls, not
    /// wall-clock time: a loaded CI runner can keep the main actor on the screen's other work past any deadline, and the
    /// composer then mounts just after a wall-clock wait has given up on it (TAL-1665). `eachPoll` runs after each miss.
    /// A clarification replaces the composer by identity, and the outgoing one stays in the window while the swap
    /// animates, so the composer counts only once it is the region's sole editor: the first of two read the leaving
    /// ordinary draft on CI (TAL-2714).
    @MainActor
    func composerTextView(
        in window: UIWindow,
        timeout: TimeInterval = 10,
        region: CGRect? = nil,
        eachPoll: @escaping () -> Void = {}
    ) async -> UITextView? {
        func soleEditor() -> UITextView? {
            let editors = window.views(ofType: UITextView.self) {
                $0.isEditable && (region?.intersects($0.convert($0.bounds, to: window)) ?? true)
            }
            return editors.count == 1 ? editors[0] : nil
        }
        for _ in 0..<Int(timeout / 0.05) {
            if let text = soleEditor() { return text }
            eachPoll()
            try? await Task.sleep(for: .milliseconds(50))
        }
        return soleEditor()
    }

    /// Types `text` into the composer the way the keyboard does: through the text view's own input path, so the
    /// composer's draft follows.
    @MainActor
    func typeIntoComposer(_ text: String, in window: UIWindow, region: CGRect? = nil) async throws {
        // Commit the offscreen navigation frame before the one focus attempt, as a real display does before a tap.
        settle(window: window)
        // A delayed expanded editor can mount without ever showing a collapsed shell.
        var activatedShell = false
        let found = await composerTextView(in: window, region: region) {
            guard !activatedShell, let shell = HostedAccessibility.elements(in: window).first(where: {
                $0.accessibilityLabel == "Message" && (region?.intersects($0.accessibilityFrame) ?? true)
            }), !shell.accessibilityTraits.contains(.notEnabled) else { return }
            activatedShell = HostedAccessibility.activate(shell)
        }
        let input = try XCTUnwrap(found, "The chat has no composer text view (shell activated: \(activatedShell))")
        input.becomeFirstResponder()
        input.insertText(text)
        // The draft reaches the composer's state through SwiftUI: wait for the display to commit what typing queued.
        if let scene = window.windowScene { await awaitDisplayUpdates(2, in: scene) }
    }

    /// Makes `change` and reports whether the software keyboard then posted `notification`.
    @MainActor
    func awaitKeyboard(_ notification: Notification.Name, after change: () async throws -> Void) async rethrows -> Bool {
        let posted = XCTNSNotificationExpectation(name: notification)
        try await change()
        return await XCTWaiter().fulfillment(of: [posted], timeout: 5) == .completed
    }

    /// Types `message` and activates Send.
    @MainActor
    func sendFromComposer(_ message: String, in window: UIWindow) async throws {
        try await typeIntoComposer(message, in: window)
        try await activateSend(in: window)
    }

    /// Activates the Send under `root` (the window, or a presented sheet's view) once it reports enabled. Typed text
    /// enables the button only on SwiftUI's next render, and a disabled button drops the activation, which a slow host
    /// showed as a send that never started (TAL-2549). `scripts/test-rules.json` (`ready-send`) rejects any other
    /// Send activation.
    @MainActor
    func activateSend(in root: UIView, file: StaticString = #filePath, line: UInt = #line) async throws {
        let enabled = await awaitCondition {
            HostedAccessibility.element(in: root, label: "Send")?.accessibilityTraits.contains(.notEnabled) == false
        }
        XCTAssertTrue(enabled, "Send never enabled", file: file, line: line)
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: root, label: "Send"), "Missing Send",
                                                   file: file, line: line))
    }

    /// Records the text Copy actions copy until the test ends, instead of the simulator-wide general pasteboard, which
    /// a test does not own (TAL-2555).
    @MainActor
    func recordCopies() -> CopiedText {
        let copied = CopiedText()
        nonisolated(unsafe) let installed = PlatformHooks.copyText
        PlatformHooks.copyText = { copied.last = $0 }
        addTeardownBlock { MainActor.assumeIsolated { PlatformHooks.copyText = installed } }
        return copied
    }

    /// Elements whose label or identifier is `name`, as XCUITest's `matching(identifier:)` counted them.
    @MainActor
    func elements(named name: String, in window: UIWindow) -> [NSObject] {
        HostedAccessibility.elements(in: window).filter {
            $0.accessibilityLabel == name || HostedAccessibility.identifier(of: $0) == name
        }
    }

    /// `awaitElement(in:where:)` that fails the test with `message` when no element matches.
    @MainActor
    func requireElement(
        in window: UIWindow,
        _ message: String = "No matching element",
        file: StaticString = #filePath,
        line: UInt = #line,
        where match: @escaping (NSObject) -> Bool
    ) async throws -> NSObject {
        let found = await awaitElement(in: window, where: match)
        return try XCTUnwrap(found, message, file: file, line: line)
    }
}
