import XCTest
import AppIntents
@testable import Talaria
@testable import TalariaKit

/// TAL-1470: Ask Talaria runs without opening the app and relays the server's reply.
@MainActor
final class AppIntentAskTalariaTests: XCTestCase {
    private var originalFactory: (() -> AskSession?)!

    override func setUp() async throws {
        try await super.setUp()
        originalFactory = AskTalariaIntent.makeAskSession
    }

    override func tearDown() async throws {
        AskTalariaIntent.makeAskSession = originalFactory
        try await super.tearDown()
    }

    func testAskWithoutAProfileUsesTheActiveProfileAndReturnsTheReply() async throws {
        XCTAssertFalse(AskTalariaIntent.openAppWhenRun)
        let fixture = AskFixture(frames: [AskFixture.doneFrame(finalAnswer: "The deploy finished.")])
        AskTalariaIntent.makeAskSession = { fixture.session() }
        let intent = AskTalariaIntent()
        intent.prompt = "Did the deploy finish?"

        let result = try await intent.perform()

        XCTAssertEqual(result.value, "Spoken: The deploy finished.")
        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["message"], "Did the deploy finish?")
        XCTAssertNil(fixture.body(at: "/api/chat/start")?["profile"], "No profile asks in the server's active profile.")
    }

    func testAskInAProfilePassesItToStartChat() async throws {
        let fixture = AskFixture(frames: [AskFixture.doneFrame(finalAnswer: "Done.")])
        AskTalariaIntent.makeAskSession = { fixture.session() }
        let intent = AskTalariaIntent()
        intent.prompt = "Status?"
        intent.profile = ProfileEntity(id: "work", name: "Work", subtitle: nil)

        _ = try await intent.perform()

        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["profile"], "work")
    }

    /// `AppShortcut` keeps its intent private, so the test reads it by reflection; the phrases are pinned by
    /// `LocalizationCatalogTests.testAppShortcutPhrasesHaveDedicatedCatalogEntries`.
    func testAppShortcutsListAskTalariaBesideTheNewChatShortcuts() {
        func intentName(_ value: Any) -> String? {
            for child in Mirror(reflecting: value).children {
                if child.value is any AppIntent { return String(describing: type(of: child.value)) }
                if let nested = intentName(child.value) { return nested }
            }
            return nil
        }
        XCTAssertEqual(
            TalariaShortcuts.appShortcuts.map { intentName($0) },
            ["AskTalariaIntent", "NewChatIntent", "NewChatVoiceIntent", "NewChatInProfileIntent"]
        )
    }
}
