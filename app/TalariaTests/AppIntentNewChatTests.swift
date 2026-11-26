import XCTest
import AppIntents
@testable import Talaria
@testable import TalariaKit

// The members of AppIntentNewChatTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class AppIntentNewChatTests: XCTestCase {
    // `AppIntentRouter` is a shared singleton, so reset its pending link around every
    // test. Doing it in setUp/tearDown (rather than inline) guarantees a clean slate
    // before each test and cleanup after every exit path — including a failed assertion
    // or a thrown error mid-test — so router state can't leak between tests.
    override func setUp() async throws {
        try await super.setUp()
        await MainActor.run {
            let router = AppIntentRouter.shared
            _ = router.takeRoute(in: router.pendingWindow)
        }
    }

    override func tearDown() async throws {
        await MainActor.run {
            let router = AppIntentRouter.shared
            _ = router.takeRoute(in: router.pendingWindow)
        }
        try await super.tearDown()
    }

    func testIntentOpensAppWhenRun() {
        XCTAssertTrue(NewChatIntent.openAppWhenRun)
    }

    /// TAL-1476: each Control Center control runs the intent that opens its own composer.
    @MainActor
    func testNewChatControlsRequestTheirDeepLinks() async throws {
        let router = AppIntentRouter.shared
        _ = try await NewChatControl.action.perform()
        XCTAssertEqual(router.pendingRoute, TalariaDeepLink.newChatURL.map(AppIntentRouter.Route.deepLink))
        _ = try await NewChatVoiceControl.action.perform()
        XCTAssertEqual(router.pendingRoute, TalariaDeepLink.newChatVoiceURL.map(AppIntentRouter.Route.deepLink))
    }

    func testVoiceIntentOpensAppWhenRun() {
        XCTAssertTrue(NewChatVoiceIntent.openAppWhenRun)
    }

    @MainActor
    func testTextIntentHandsItsExactTextAndProfileToTheForegroundWithoutWritingToTheAppGroup() async throws {
        let router = AppIntentRouter.shared
        defer { _ = router.takeRoute(in: router.pendingWindow) }
        let container = try XCTUnwrap(TalariaShareDraft.containerURL(), "The signed test app must have its own App Group")
        func entries() throws -> [String: Date] {
            let urls = try XCTUnwrap(FileManager.default.enumerator(at: container, includingPropertiesForKeys: [.contentModificationDateKey]))
            var entries: [String: Date] = [:]
            for case let url as URL in urls {
                entries[url.path] = try XCTUnwrap(url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
            }
            return entries
        }
        let before = try entries()
        let text = "  Café ☕\nCheck this before sending.\n  "
        let intent = NewChatWithTextIntent()
        intent.text = text
        intent.profile = Self.dev

        XCTAssertTrue(NewChatWithTextIntent.openAppWhenRun)
        _ = try await intent.perform()

        XCTAssertEqual(try entries(), before)
        guard case .newChat(let request)? = router.takeRoute(in: router.pendingWindow) else {
            return XCTFail("The Shortcut must leave an in-memory New Chat request")
        }
        XCTAssertEqual(request.initialDraft.map { Array($0.utf8) }, Array(text.utf8))
        XCTAssertEqual(request.profileName, Self.dev.id)
    }

    @MainActor
    func testTextIntentRejectsInputBeyondItsUTF8Budget() async throws {
        let router = AppIntentRouter.shared
        defer { _ = router.takeRoute(in: router.pendingWindow) }
        let intent = NewChatWithTextIntent()
        intent.text = String(repeating: "é", count: 51_200)
        _ = try await intent.perform()
        _ = router.takeRoute(in: router.pendingWindow)
        intent.text += "!"

        do {
            _ = try await intent.perform()
            XCTFail("A Shortcut with more than 100 KiB must throw an intent error")
        } catch {
            XCTAssertNil(router.pendingRoute, "Refusing the input must leave navigation alone")
        }
    }

    /// TAL-50: a deleted profile still resolves, so WidgetKit keeps a widget's configured profile instead of swapping in
    /// the active one; the server then refuses the deleted profile on the first Send.
    func testProfileQueryKeepsAnIdentifierTheServerNoLongerLists() {
        let resolved = ProfileEntityQuery.resolve(["dev", "deleted"], in: [Self.dev])
        XCTAssertEqual(resolved.map(\.id), ["dev", "deleted"])
        XCTAssertEqual(resolved.first?.name, "Dev")
    }

    private static let dev = ProfileEntity(id: "dev", name: "Dev", subtitle: nil)
}
