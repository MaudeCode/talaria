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
}
