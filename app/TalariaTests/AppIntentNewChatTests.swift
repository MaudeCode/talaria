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
        await MainActor.run { AppIntentRouter.shared.pendingDeepLink = nil }
    }

    override func tearDown() async throws {
        await MainActor.run { AppIntentRouter.shared.pendingDeepLink = nil }
        try await super.tearDown()
    }

    @MainActor
    func testNewChatIntentQueuesTheNewChatDeepLink() async throws {
        let router = AppIntentRouter.shared
        _ = try await NewChatIntent().perform()
        XCTAssertEqual(router.pendingDeepLink, TalariaDeepLink.newChatURL)
    }

    func testIntentOpensAppWhenRun() {
        XCTAssertTrue(NewChatIntent.openAppWhenRun)
    }

    @MainActor
    func testNewChatVoiceIntentQueuesTheVoiceDeepLink() async throws {
        let router = AppIntentRouter.shared
        _ = try await NewChatVoiceIntent().perform()
        XCTAssertEqual(router.pendingDeepLink, TalariaDeepLink.newChatVoiceURL)
    }

    func testVoiceIntentOpensAppWhenRun() {
        XCTAssertTrue(NewChatVoiceIntent.openAppWhenRun)
    }
}
