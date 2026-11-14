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

    /// TAL-1476: each Control Center control runs the intent that opens its own composer.
    @MainActor
    func testNewChatControlsRequestTheirDeepLinks() async throws {
        let router = AppIntentRouter.shared
        _ = try await NewChatControl.action.perform()
        XCTAssertEqual(router.pendingDeepLink, TalariaDeepLink.newChatURL)
        _ = try await NewChatVoiceControl.action.perform()
        XCTAssertEqual(router.pendingDeepLink, TalariaDeepLink.newChatVoiceURL)
    }

    func testVoiceIntentOpensAppWhenRun() {
        XCTAssertTrue(NewChatVoiceIntent.openAppWhenRun)
    }

    /// TAL-50: an unconfigured New Chat widget opens a plain new chat.
    func testNewChatWidgetWithoutProfileOpensPlainNewChat() {
        let entry = NewChatWidgetEntry(configuration: .init(), available: [Self.dev])
        XCTAssertNil(entry.profile)
        XCTAssertNil(entry.missingProfileName)
    }

    /// TAL-50: a widget configured with a listed profile opens the New Chat composer pinned to it.
    @MainActor
    func testNewChatWidgetWithProfileOpensTheProfileComposer() async throws {
        let entry = NewChatWidgetEntry(configuration: .init(profile: Self.dev), available: [Self.dev])
        let profile = try XCTUnwrap(entry.profile)
        XCTAssertNil(entry.missingProfileName)

        _ = try await NewChatInProfileIntent(profile: profile).perform()
        XCTAssertEqual(AppIntentRouter.shared.pendingDeepLink, TalariaDeepLink.newChatInProfileURL(profileName: "dev"))
    }

    /// TAL-50: a configured profile the App no longer lists shows the recovery prompt and opens a plain new chat.
    func testNewChatWidgetWithMissingProfileShowsRecovery() {
        let entry = NewChatWidgetEntry(configuration: .init(profile: Self.dev), available: [Self.work])
        XCTAssertNil(entry.profile)
        XCTAssertEqual(entry.missingProfileName, "Dev")
    }

    /// TAL-50: with no cached profiles (signed out) the widget keeps its profile and leaves recovery to the App.
    func testNewChatWidgetWithoutCachedProfilesKeepsTheProfile() {
        let entry = NewChatWidgetEntry(configuration: .init(profile: Self.dev), available: [])
        XCTAssertEqual(entry.profile?.id, "dev")
        XCTAssertNil(entry.missingProfileName)
    }

    /// TAL-50: a deleted profile still resolves, so WidgetKit keeps the widget's configuration and its recovery prompt.
    func testProfileQueryKeepsAnIdentifierTheServerNoLongerLists() {
        let resolved = ProfileEntityQuery.resolve(["dev", "deleted"], in: [Self.dev])
        XCTAssertEqual(resolved.map(\.id), ["dev", "deleted"])
        XCTAssertEqual(resolved.first?.name, "Dev")
    }

    private static let dev = ProfileEntity(id: "dev", name: "Dev", subtitle: nil)
    private static let work = ProfileEntity(id: "work", name: "Work", subtitle: nil)
}
