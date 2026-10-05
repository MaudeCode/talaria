import XCTest
@testable import TalariaKit

/// TAL-636: a new chat's view model starts without a session and takes on the one the server
/// creates, in place, so the composer bound to it is never rebuilt.
@MainActor
extension ChatViewModelSendTests {
    func testNewChatAdoptsTheCreatedSessionOnceAndSendsToIt() async throws {
        var startedSessionID: String?
        let viewModel = try makeViewModel(sessionSummary: SessionSummary(title: "New Chat")) { request in
            switch request.url?.path {
            case "/api/chat/start":
                startedSessionID = try apiTestJSONBody(from: request)["session_id"] as? String
                return apiTestJSONResponse(#"{"session_id":"session-created","stream_id":"stream-1"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        XCTAssertFalse(viewModel.hasSession)

        viewModel.adoptCreatedSession(SessionSummary(sessionId: "session-created", title: "Fresh chat", workspace: "/tmp/workspace"))
        XCTAssertTrue(viewModel.hasSession)
        XCTAssertEqual(viewModel.displayTitle, "Fresh chat")

        // Only the first adoption counts: a late second answer cannot repoint the chat.
        viewModel.adoptCreatedSession(SessionSummary(sessionId: "session-other", title: "Other"))
        XCTAssertEqual(viewModel.displayTitle, "Fresh chat")

        let didStart = await viewModel.sendMessage("Hello")
        XCTAssertTrue(didStart)
        XCTAssertEqual(startedSessionID, "session-created")
    }

    func testAdoptingASessionWithoutAnIDLeavesTheChatWaiting() throws {
        let viewModel = try makeViewModel(sessionSummary: SessionSummary(title: "New Chat")) { request in
            XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        viewModel.adoptCreatedSession(SessionSummary(sessionId: "  ", title: "Blank"))

        XCTAssertFalse(viewModel.hasSession)
    }
}
