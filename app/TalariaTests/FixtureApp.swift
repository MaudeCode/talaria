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
final class FixtureApp {
    let environment: UITestFixtureEnvironment
    let cache: ModelContainer
    /// A screen's refresh task can still write its cache after its test ends; SwiftData traps on a context whose
    /// container is gone, so every hosted test's in-memory cache lives for the rest of the run.
    private static var retainedCaches: [ModelContainer] = []

    var client: APIClient { environment.client }

    init(_ scenario: [String] = [], for testCase: XCTestCase) throws {
        FixtureLaunchArguments.scenario = [UITestFixtureLaunch.launchArgument] + scenario
        UITestFixtureURLProtocol.resetForHostedTest()
        // A relaunch empties what a process keeps in memory per session; hosted tests share one process.
        ActiveChatStreamSnapshotStore.shared.removeAll(for: UITestFixtureEnvironment.serverURL)
        environment = UITestFixtureEnvironment.make()
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

    /// Answers every load the scenario held, as the UI tests' `releaseHeldLoads` did.
    func releaseHeldLoads() {
        UITestFixtureHold.shared.release()
    }

    func session(_ sessionID: String = UITestFixtureURLProtocol.sessionID) async throws -> SessionSummary {
        let sessions = try await client.sessions().sessions ?? []
        return try XCTUnwrap(sessions.first { $0.sessionId == sessionID }, "The fixture lists no \(sessionID)")
    }

    /// The chat pushed the way the session list pushes it: it starts its loads once its push has finished.
    func chat(_ session: SessionSummary) -> some View {
        NavigationStack {
            Color.clear.navigationDestination(isPresented: .constant(true)) {
                ChatView(
                    session: session,
                    server: UITestFixtureEnvironment.serverURL,
                    onAPIError: { _ in },
                    draftStore: self.environment.draftStore
                )
            }
        }
        // A window outside SwiftUI's scene lifecycle reports no scene phase of its own; the App's runs in the foreground.
        .environment(\.scenePhase, .active)
        .modelContainer(cache)
    }

    func sessionList() -> some View {
        SessionListView(
            authManager: environment.authManager,
            server: UITestFixtureEnvironment.serverURL,
            draftStore: environment.draftStore
        )
        .environment(\.scenePhase, .active)
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
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !HostedAccessibility.elements(in: window).contains(where: match) { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return !HostedAccessibility.elements(in: window).contains(where: match)
    }

    /// The chat composer's text view, once the chat has one.
    @MainActor
    func composerTextView(in window: UIWindow, timeout: TimeInterval = 10) async -> UITextView? {
        func find(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap(find).first
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let text = find(window) { return text }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return find(window)
    }

    /// Types `text` into the composer the way the keyboard does: through the text view's own input path, so the
    /// composer's draft follows.
    @MainActor
    func typeIntoComposer(_ text: String, in window: UIWindow) async throws {
        // A chat with a transcript shows its composer as the collapsed "Message" shell until it is tapped.
        var found = await composerTextView(in: window, timeout: 2)
        if found == nil, let shell = await awaitElement(in: window, label: "Message") {
            HostedAccessibility.activate(shell)
            found = await composerTextView(in: window)
        }
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
