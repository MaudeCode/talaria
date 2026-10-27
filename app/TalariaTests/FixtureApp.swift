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
    let cache: ModelContainer
    var pendingSessionID: String?
    var opensQuotaWidgetSettings = false
    /// A screen's refresh task can still write its cache after its test ends; SwiftData traps on a context whose
    /// container is gone, so every hosted test's in-memory cache lives for the rest of the run.
    private static var retainedCaches: [ModelContainer] = []

    var client: APIClient { environment.client }

    init(_ scenario: [String] = [], for testCase: XCTestCase) throws {
        FixtureLaunchArguments.scenario = [UITestFixtureLaunch.launchArgument] + scenario
        UITestFixtureURLProtocol.resetForHostedTest()
        // A relaunch empties what a process keeps in memory per session; hosted tests share one process.
        ActiveChatStreamSnapshotStore.shared.removeAll(for: UITestFixtureEnvironment.serverURL)
        ChatViewModel.forgetCompanionPages()
        environment = UITestFixtureEnvironment.make()
        // Each hosted journey owns its sidebar choices; a second window within it still exercises persistence.
        for key in [SessionSidebarDisclosureSettings.regularPortraitVisibilityKey,
                    SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey,
                    SessionNavigationPersistence.key(for: UITestFixtureEnvironment.serverURL)] {
            UserDefaults.standard.removeObject(forKey: key)
        }
        cache = try ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        Self.retainedCaches.append(cache)
        // No load may stay held into the next test.
        testCase.addTeardownBlock {
            MainActor.assumeIsolated {
                UITestFixtureHold.shared.release()
                FixtureLaunchArguments.scenario = []
                UITestFixtureURLProtocol.resetForHostedTest()
            }
        }
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
              asNavigationDestination: Bool = true) -> some View {
        let chat = ChatView(
            session: session,
            server: UITestFixtureEnvironment.serverURL,
            onAPIError: { _ in },
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

    func sessionList(scenePhase: ScenePhase = .active, chats: ChatViewModelCache? = nil,
                     viewModel: SessionListViewModel? = nil) -> some View {
        SessionListView(
            authManager: environment.authManager,
            server: UITestFixtureEnvironment.serverURL,
            modelContext: cache.mainContext,
            pendingDeepLinkedSessionID: Binding(get: { self.pendingSessionID }, set: { self.pendingSessionID = $0 }),
            opensProviderQuotaWidgetSettings: Binding(get: { self.opensQuotaWidgetSettings }, set: { self.opensQuotaWidgetSettings = $0 }),
            draftStore: environment.draftStore,
            chats: chats,
            viewModel: viewModel
        )
        .environment(\.scenePhase, scenePhase)
        .modelContainer(cache)
    }
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

    /// Waits until no transcript row has realized for 500 ms and returns the settled count, or nil if rows kept
    /// realizing. Lazy layout can shift the mounted window once more after startup, especially on CI (TAL-1544).
    @MainActor
    func awaitQuietRowRealization(_ rows: ChatTranscriptRowCache) async -> Int? {
        var count = rows.realizationCount
        let clock = ContinuousClock()
        var lastRealization = clock.now
        let settled = await awaitCondition {
            if rows.realizationCount != count {
                count = rows.realizationCount
                lastRealization = clock.now
            }
            return clock.now - lastRealization >= .milliseconds(500)
        }
        return settled ? count : nil
    }

    /// Reads either composer presentation; a missing composer is not an empty draft.
    @MainActor
    func composerDraftText(in window: UIWindow) -> String? {
        if let input = window.firstView(ofType: ComposerTextView.PastingTextView.self) {
            return input.text
        }
        return HostedAccessibility.element(in: window, label: "Message") == nil ? nil : ""
    }

    /// The chat composer's text view, once the chat has one.
    @MainActor
    func composerTextView(in window: UIWindow, timeout: TimeInterval = 10) async -> UITextView? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let text = window.firstView(ofType: UITextView.self, where: \.isEditable) { return text }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return window.firstView(ofType: UITextView.self, where: \.isEditable)
    }

    /// Types `text` into the composer the way the keyboard does: through the text view's own input path, so the
    /// composer's draft follows.
    @MainActor
    func typeIntoComposer(_ text: String, in window: UIWindow) async throws {
        // A delayed expanded editor can mount without ever showing a collapsed shell.
        var found: UITextView?
        var expandedShell = false
        let deadline = Date().addingTimeInterval(10)
        while found == nil && Date() < deadline {
            found = await composerTextView(in: window, timeout: 0)
            if found != nil { break }
            if !expandedShell, let shell = HostedAccessibility.element(in: window, label: "Message") {
                HostedAccessibility.activate(shell)
                expandedShell = true
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        if found == nil { found = await composerTextView(in: window, timeout: 0) }
        let input = try XCTUnwrap(found, "The chat has no composer text view")
        input.becomeFirstResponder()
        input.insertText(text)
        try? await Task.sleep(for: .milliseconds(100))
    }

    /// Types `message` and activates Send.
    @MainActor
    func sendFromComposer(_ message: String, in window: UIWindow) async throws {
        try await typeIntoComposer(message, in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send"))
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
