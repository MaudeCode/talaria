import XCTest
import AppIntents
@testable import Talaria
@testable import TalariaKit

/// TAL-1470: Ask Talaria runs without opening the app and relays the server's reply. TAL-2231: on iOS 27 Ask and Reply
/// wait for the whole run in the background, and Reply continues the last chat.
@MainActor
final class AppIntentAskTalariaTests: XCTestCase {
    private var originalFactory: (() -> AskSession?)!
    private var originalAppLock: AppLockModel!

    override func setUp() async throws {
        try await super.setUp()
        originalFactory = AskTalariaIntent.makeAskSession
        originalAppLock = AskTalariaIntent.appLock
        AskTalariaIntent.appLock = AppLockModel(defaults: lockDefaults(enabled: false))
        AskTalariaIntent.inPlaceProgress = Progress()
    }

    override func tearDown() async throws {
        AskTalariaIntent.makeAskSession = originalFactory
        AskTalariaIntent.appLock = originalAppLock
        AskTalariaIntent.inPlaceProgress = nil
        try await super.tearDown()
    }

    private func lockDefaults(enabled: Bool) -> UserDefaults {
        let name = "AppIntentAskTalariaTests.\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        defaults.set(enabled, forKey: AppLockModel.isEnabledKey)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
        return defaults
    }

    /// App Lock guards the agent too: a locked Talaria asks nothing and speaks nothing until it is unlocked.
    func testLockedAppAsksNothing() async throws {
        AskTalariaIntent.appLock = AppLockModel(defaults: lockDefaults(enabled: true))
        let fixture = AskFixture(frames: [AskFixture.doneFrame(finalAnswer: "Secret reply.")])
        AskTalariaIntent.makeAskSession = { fixture.session() }
        let intent = AskTalariaIntent()
        intent.prompt = "Status?"

        let reply = try? await intent.perform().value

        XCTAssertNil(reply)
        XCTAssertEqual(fixture.paths, [])
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

    // MARK: - TAL-2231

    func testAskAndReplyRunInTheBackgroundOnlyAsCancellableLongRunningIntents() throws {
        guard #available(iOS 27, *) else { throw XCTSkip("Long-running intents need iOS 27.") }
        XCTAssertEqual(Self.modes(of: AskTalariaIntent.self), .background)
        XCTAssertEqual(Self.modes(of: ReplyToTalariaIntent.self), .background)
        let intents: [any AppIntent] = [AskTalariaIntent(), ReplyToTalariaIntent()]
        XCTAssertTrue(intents.allSatisfy { $0 is any LongRunningIntent & CancellableIntent })
    }

    func testLongRunReportsTheServersActivityAndReturnsTheFinalTextAfterNinetySeconds() async throws {
        guard #available(iOS 27, *) else { throw XCTSkip("Long-running intents need iOS 27.") }
        let clock = ManualTestClock()
        let fixture = AskFixture(frames: [AskFixture.toolFrame(preview: "Running ./deploy.sh --prod")])
        AskTalariaIntent.makeAskSession = { fixture.session(clock: clock) }
        let intent = AskTalariaIntent()
        intent.prompt = "Deploy"
        let progress = try XCTUnwrap(AskTalariaIntent.inPlaceProgress)

        let asking = Task { try await intent.perform().value }
        try await TalariaTests.waitUntil { progress.completedUnitCount > 0 }
        XCTAssertEqual(progress.localizedDescription, "Running ./deploy.sh --prod")
        for _ in 0..<18 { await clock.advance(by: .seconds(5)) }
        XCTAssertGreaterThanOrEqual(progress.completedUnitCount, 19, "No minute timeout: the heartbeat keeps the task alive.")
        XCTAssertEqual(progress.localizedDescription, "Running ./deploy.sh --prod")
        fixture.stream.send([AskFixture.doneFrame(finalAnswer: "Deployed.")])

        let reply = try await asking.value
        XCTAssertEqual(reply, "Spoken: Deployed.")
    }

    func testCancelledLongRunSaysItIsStillWorkingAndLeavesTheRunGoing() async throws {
        guard #available(iOS 27, *) else { throw XCTSkip("Long-running intents need iOS 27.") }
        let fixture = AskFixture(frames: [AskFixture.toolFrame(preview: "Reading logs")])
        AskTalariaIntent.makeAskSession = { fixture.session() }
        let intent = AskTalariaIntent()
        intent.prompt = "Long job"
        let progress = try XCTUnwrap(AskTalariaIntent.inPlaceProgress)

        let asking = Task { try await intent.perform() }
        try await TalariaTests.waitUntil { progress.completedUnitCount > 0 }
        asking.cancel()

        let result = try await asking.value
        XCTAssertEqual(result.value, "")
        XCTAssertEqual(fixture.stream.stopCount, 1)
        XCTAssertFalse(fixture.paths.contains { $0.contains("cancel") }, "\(fixture.paths)")
    }

    func testReplyContinuesTheLastChatAndWithoutOneAsksInANewChat() async throws {
        let memory = AskFixture.memory(in: self)
        let fixture = AskFixture(frames: [AskFixture.doneFrame(finalAnswer: "Done.")])
        AskTalariaIntent.makeAskSession = { fixture.session(memory: memory) }
        let reply = ReplyToTalariaIntent()
        reply.text = "Status?"
        XCTAssertFalse(ReplyToTalariaIntent.openAppWhenRun)

        _ = try await reply.perform()
        XCTAssertEqual(fixture.paths.prefix(2), ["/api/session/new", "/api/chat/start"], "No stored chat: Reply asks as Ask does.")

        _ = try await reply.perform()
        XCTAssertEqual(fixture.paths.filter { $0 == "/api/session/new" }.count, 1, "\(fixture.paths)")
        XCTAssertEqual(fixture.bodies(at: "/api/chat/start").last?["session_id"], AskFixture.sessionID)
        XCTAssertEqual(fixture.bodies(at: "/api/chat/start").last?["message"], "Status?")
    }

    /// Before iOS 27 Ask and Reply keep the modes TAL-1470's Ask had: no app launch, continuable in the foreground.
    func testBeforeIOS27AskAndReplyKeepTheModesTheFirstAskHad() throws {
        guard #available(iOS 26, *) else { throw XCTSkip("Intent modes start in iOS 26.") }
        if #available(iOS 27, *) { throw XCTSkip("iOS 27 runs them in the background only.") }
        struct FirstAsk: AppIntent, ForegroundContinuableIntent {
            static let title: LocalizedStringResource = "First Ask"
            static let openAppWhenRun = false
            func perform() async throws -> some IntentResult { .result() }
        }
        XCTAssertEqual(Self.modes(of: AskTalariaIntent.self), Self.modes(of: FirstAsk.self))
        XCTAssertEqual(Self.modes(of: ReplyToTalariaIntent.self), Self.modes(of: FirstAsk.self))
    }

    /// The modes the App Intents runtime reads, through the protocol rather than the concrete type.
    @available(iOS 26, *)
    private static func modes<Intent: AppIntent>(of _: Intent.Type) -> IntentModes { Intent.supportedModes }
}
