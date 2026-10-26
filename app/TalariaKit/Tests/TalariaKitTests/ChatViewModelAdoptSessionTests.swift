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

    func testRefusedFirstPostRestoresOneUploadedFileAndReusesTheCreatedSession() async throws {
        var uploads = 0
        var posts = 0
        var creations = 0
        let model = try makeViewModel(sessionSummary: SessionSummary(title: "New Chat")) { request in
            switch request.url?.path {
            case "/api/upload":
                uploads += 1
                return apiTestJSONResponse(#"{"path":"/uploads/first.txt","mime":"text/plain","is_image":false}"#, for: request)
            case "/api/chat/start":
                posts += 1
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual(body["session_id"] as? String, "created")
                let files = try XCTUnwrap(body["attachments"] as? [[String: Any]])
                XCTAssertEqual(files.count, 1)
                XCTAssertEqual(files.first?["path"] as? String, "/uploads/first.txt")
                if posts == 1 { return apiTestJSONResponse(#"{"error":"Synthetic refusal"}"#, statusCode: 409, for: request) }
                return apiTestJSONResponse(#"{"session_id":"created","stream_id":"retry-stream"}"#, for: request)
            default:
                XCTFail("Unexpected request \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        let staged = await model.stageAttachment(data: Data("synthetic bytes".utf8), filename: "first.txt")
        let id = try XCTUnwrap(staged?.id)
        let first = await model.sendMessage("First prompt", waitForSession: {
            creations += 1
            model.adoptCreatedSession(SessionSummary(sessionId: "created", title: "Created"))
            await model.uploadStagedAttachments()
            return true
        }, sessionAttachments: { model.sessionStartupAttachments })
        XCTAssertFalse(first)
        XCTAssertEqual(model.pendingAttachments.map(\.id), [id])
        XCTAssertEqual(model.pendingAttachments.first?.path, "/uploads/first.txt")
        XCTAssertTrue(model.sessionStartupAttachments.isEmpty)
        let retry = await model.sendMessage("First prompt")
        XCTAssertTrue(retry)
        XCTAssertEqual(creations, 1)
        XCTAssertEqual(uploads, 1)
        XCTAssertEqual(posts, 2)
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
