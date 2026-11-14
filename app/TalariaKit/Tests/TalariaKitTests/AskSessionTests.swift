import XCTest
@testable import TalariaKit

/// TAL-1470: Ask Talaria starts a chat, follows its stream, and returns what the server said.
@MainActor
final class AskSessionTests: XCTestCase {
    func testReplyIsTheServersReadAloudScriptOfTheFinalAnswer() async throws {
        let fixture = AskFixture(frames: [
            ("token", #"{"text":"The deploy "}"#),
            ("token", #"{"text":"finished."}"#),
            AskFixture.doneFrame(finalAnswer: "**The deploy** finished."),
        ])

        let result = try await fixture.session().ask("Did the deploy finish?", profile: nil)

        XCTAssertEqual(result.status, .replied)
        XCTAssertEqual(result.text, "Spoken: **The deploy** finished.")
        XCTAssertEqual(result.sessionURL, TalariaDeepLink.sessionURL(sessionID: AskFixture.sessionID))
        XCTAssertEqual(fixture.paths, ["/api/session/new", "/api/chat/start", "/api/speech/prepare"])
        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["message"], "Did the deploy finish?")
        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["session_id"], AskFixture.sessionID)
        XCTAssertNil(fixture.body(at: "/api/chat/start")?["profile"])
        XCTAssertNil(fixture.body(at: "/api/profile/switch"), "No profile keeps the active one.")
        XCTAssertEqual(fixture.stream.startedURLs.first?.query?.contains("stream_id=ask-stream-1"), true)
        XCTAssertEqual(fixture.stream.stopCount, 1)
    }

    func testApprovalReturnsTheServersPromptAndTheChatLinkWithoutAnswering() async throws {
        let fixture = AskFixture(frames: [
            ("approval", #"{"approval_id":"ap-1","tool_call_id":"call-1","description":"Run the deploy script?","command":"./deploy.sh"}"#),
            AskFixture.doneFrame(finalAnswer: "Never reached."),
        ])

        let result = try await fixture.session().ask("Deploy it", profile: "work")

        XCTAssertEqual(result.status, .needsInput)
        XCTAssertEqual(result.text, "Run the deploy script?")
        XCTAssertEqual(result.sessionURL, TalariaDeepLink.sessionURL(sessionID: AskFixture.sessionID))
        XCTAssertEqual(fixture.paths.first, "/api/profile/switch", "A picked profile becomes the request context first.")
        XCTAssertEqual(fixture.body(at: "/api/profile/switch")?["name"], "work")
        XCTAssertEqual(fixture.body(at: "/api/session/new")?["profile"], "work")
        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["profile"], "work")
        XCTAssertFalse(fixture.paths.contains { $0.contains("approval") }, "\(fixture.paths)")
    }

    func testClarifyReturnsTheServersQuestion() async throws {
        let fixture = AskFixture(frames: [
            ("clarify", #"{"clarify_id":"c-1","steps":[{"qid":"q1","question":"Which environment?","choices":["staging","prod"],"multi_select":false}]}"#),
        ])

        let result = try await fixture.session().ask("Deploy it", profile: nil)

        XCTAssertEqual(result.status, .needsInput)
        XCTAssertEqual(result.text, "Which environment?")
    }

    func testRunPastTheTimeoutIsStillWorkingAndLeavesTheChat() async throws {
        let fixture = AskFixture(frames: [("token", #"{"text":"Checking"}"#)])

        let result = try await fixture.session(timeout: .milliseconds(50)).ask("Long job", profile: nil)

        XCTAssertEqual(result.status, .stillWorking)
        XCTAssertEqual(result.sessionURL, TalariaDeepLink.sessionURL(sessionID: AskFixture.sessionID))
        XCTAssertEqual(fixture.stream.stopCount, 1)
        XCTAssertFalse(fixture.paths.contains { $0.contains("cancel") || $0.contains("delete") }, "\(fixture.paths)")
    }

    func testServerErrorIsReturnedAsIs() async throws {
        let fixture = AskFixture(frames: [("apperror", #"{"message":"No provider configured","terminal_state":"error"}"#)])

        let result = try await fixture.session().ask("Hello", profile: nil)

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.text, "No provider configured")
    }

    // MARK: - TAL-2231: Reply continues the last chat; long runs report progress

    func testAskWithAStoredSessionContinuesItInsteadOfStartingAnother() async throws {
        let memory = AskFixture.memory(in: self)
        memory.remember(.init(sessionID: "earlier-chat", profile: "work"))
        let fixture = AskFixture(frames: [AskFixture.doneFrame(finalAnswer: "Done.")])
        let session = fixture.session(memory: memory)
        let last = try XCTUnwrap(session.last)

        let result = try await session.ask("And now?", profile: last.profile, sessionID: last.sessionID)

        XCTAssertEqual(result.status, .replied)
        XCTAssertEqual(fixture.paths, ["/api/profile/switch", "/api/chat/start", "/api/speech/prepare"])
        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["session_id"], "earlier-chat")
        XCTAssertEqual(fixture.body(at: "/api/chat/start")?["profile"], "work")
        XCTAssertEqual(result.sessionURL, TalariaDeepLink.sessionURL(sessionID: "earlier-chat"))
    }

    func testAskWithoutAStoredSessionStartsOneAndRemembersItForThisServerOnly() async throws {
        let memory = AskFixture.memory(in: self)
        let fixture = AskFixture(frames: [AskFixture.doneFrame(finalAnswer: "Done.")])
        let session = fixture.session(memory: memory)
        XCTAssertNil(session.last, "A reply with nothing stored asks in a new chat.")

        _ = try await session.ask("Status?", profile: nil, sessionID: session.last?.sessionID)

        XCTAssertEqual(fixture.paths.prefix(2), ["/api/session/new", "/api/chat/start"])
        XCTAssertEqual(session.last, .init(sessionID: AskFixture.sessionID, profile: nil))
        let otherServer = AskSession.Memory(serverID: "https://other.example.test", defaults: memory.defaults)
        XCTAssertNil(otherServer.last, "Another server's chat is never continued.")
    }

    func testProgressCarriesTheServersActivityTextAndAQuietStreamKeepsTicking() async throws {
        let clock = ManualTestClock()
        let fixture = AskFixture(frames: [AskFixture.toolFrame(preview: "Running ./deploy.sh --prod")])
        let progress = Progress()
        let recorded = LockedTestValue<[(count: Int64, text: String?)]>([])
        let observation = progress.observe(\.completedUnitCount) { progress, _ in
            recorded.value.append((progress.completedUnitCount, progress.localizedDescription))
        }
        defer { observation.invalidate() }

        let asking = Task { try await fixture.session(timeout: nil, clock: clock).ask("Deploy", profile: nil, progress: progress) }
        try await waitUntil { !recorded.value.isEmpty }
        for _ in 0..<6 { await clock.advance(by: .seconds(5)) }
        let updates = recorded.value

        XCTAssertGreaterThanOrEqual(updates.count, 7, "One activity, then a tick every 5 s over 30 s of silence.")
        XCTAssertEqual(Set(updates.map(\.text)), ["Running ./deploy.sh --prod"])
        XCTAssertEqual(updates.map(\.count), updates.indices.map { Int64($0 + 1) }, "Each update advances the count.")

        fixture.stream.send([AskFixture.doneFrame(finalAnswer: "Deployed.")])
        let result = try await asking.value
        XCTAssertEqual(result.text, "Spoken: Deployed.")
    }

    func testCancellingTheTaskLeavesTheRunGoingOnTheServer() async throws {
        let fixture = AskFixture(frames: [AskFixture.toolFrame(preview: "Reading logs")])
        let progress = Progress()
        let asking = Task { try await fixture.session(timeout: nil).ask("Long job", profile: nil, progress: progress) }
        try await waitUntil { progress.completedUnitCount > 0 }

        asking.cancel()
        let result = try await asking.value

        XCTAssertEqual(result.status, .stillWorking)
        XCTAssertEqual(fixture.stream.stopCount, 1)
        XCTAssertFalse(fixture.paths.contains { $0.contains("cancel") }, "\(fixture.paths)")
    }
}
