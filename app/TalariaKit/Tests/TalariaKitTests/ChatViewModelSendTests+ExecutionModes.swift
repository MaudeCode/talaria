import XCTest
@testable import TalariaKit

/// TAL-1045: a chat shows the mode the server froze when it created it, from the shared TAL-1040 fixtures, and keeps
/// it across reconnects and offline display. The App never requests a mode for an existing chat.
@MainActor
extension ChatViewModelSendTests {
    /// The fixture's session, with one message so the transcript cache keeps it for offline display.
    static func diagnosticSessionJSON(_ key: String) throws -> String {
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try executionModesFixture(key).utf8)) as? [String: Any])
        var session = try XCTUnwrap(envelope["session"] as? [String: Any])
        session["session_id"] = "session-abc"
        session["messages"] = [["role": "user", "content": "Is a plugin breaking this?", "message_id": "diagnostic-1"]]
        session["message_count"] = 1
        return String(decoding: try JSONSerialization.data(withJSONObject: session), as: UTF8.self)
    }

    func testANewChatTakesOnTheModeAndOwnerTheServerCreatedItWith() async throws {
        let created = try APIClient.responseDecoder().decode(SessionResponse.self, from: Data(try executionModesFixture("created").utf8))
        let detail = try XCTUnwrap(created.session)
        let viewModel = try makeViewModel(sessionSummary: SessionSummary(title: "New Chat")) { request in
            apiTestJSONResponse("{}", for: request)
        }

        viewModel.adoptCreatedSession(SessionSummary(from: detail), detail: detail)

        XCTAssertEqual(viewModel.executionMode, .safe)
        XCTAssertEqual(viewModel.ownerAttachment?.isAttached, true, "The owner the chat runs through is known before any reload")
        XCTAssertFalse(viewModel.isComposerReadOnly, "The attached owner takes the first message")
    }

    /// A new chat has no cache until its first transcript save, so the mode it adopted must still reach that row.
    func testANewDiagnosticChatsModeIsCachedWithItsFirstTranscript() async throws {
        final class State: @unchecked Sendable { var offline = false }
        let state = State()
        let context = try makeContext()
        let created = try APIClient.responseDecoder().decode(SessionResponse.self, from: Data(try executionModesFixture("created").utf8))
        let detail = try XCTUnwrap(created.session)
        let sessionID = try XCTUnwrap(detail.sessionId)
        let viewModel = try makeViewModel(sessionSummary: SessionSummary(title: "New Chat")) { request in
            if state.offline { throw URLError(.notConnectedToInternet) }
            guard request.url?.path == "/api/chat/start" else { return apiTestJSONResponse("{}", for: request) }
            return apiTestJSONResponse(#"{"session_id":"\#(sessionID)","stream_id":"owner-stream","admission_id":"admission-1"}"#, for: request)
        }
        // The list caches the created row when it claims it, before the chat has a cache context of its own.
        try CacheStore.cacheSession(SessionSummary(from: detail), serverURL: try XCTUnwrap(URL(string: "https://example.test")), in: context)
        viewModel.adoptCreatedSession(SessionSummary(from: detail), detail: detail)
        let sent = await viewModel.sendMessage("Is a plugin breaking this?")
        XCTAssertTrue(sent)
        viewModel.persistTranscript(modelContext: context)

        state.offline = true
        let reopened = try makeViewModel(sessionSummary: SessionSummary(from: detail)) { _ in throw URLError(.notConnectedToInternet) }
        await reopened.loadMessages(modelContext: context)

        XCTAssertTrue(reopened.isViewingCachedData)
        XCTAssertEqual(reopened.executionMode, .safe, "The cached new chat still says how it runs")
        XCTAssertEqual(reopened.ownerAttachment?.isAttached, true)
    }

    func testAnExistingChatShowsItsFrozenModeFromEveryDetailAndOfflineCache() async throws {
        final class State: @unchecked Sendable { var offline = false }
        let state = State()
        let context = try makeContext()
        let existing = try Self.diagnosticSessionJSON("existing")
        func viewModel() throws -> ChatViewModel {
            try makeViewModel { request in
                if state.offline { throw URLError(.notConnectedToInternet) }
                return apiTestJSONResponse(#"{"session":\#(existing)}"#, for: request)
            }
        }
        let online = try viewModel()
        await online.loadMessages(modelContext: context)
        XCTAssertEqual(online.executionMode, .ignoreConfig)
        await online.loadMessages(modelContext: context)
        XCTAssertEqual(online.executionMode, .ignoreConfig, "A reload keeps the server's frozen mode")

        state.offline = true
        let offline = try viewModel()
        await offline.loadMessages(modelContext: context)

        XCTAssertTrue(offline.isViewingCachedData)
        XCTAssertEqual(offline.executionMode, .ignoreConfig, "The cached chat still says how it runs")
    }

    func testAChatFromAnOlderServerOrANormalChatShowsNoMode() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse(#"{"session":{"session_id":"session-abc","messages":[{"role":"user","content":"Hi"}]}}"#, for: request)
        }
        await viewModel.loadMessages()

        XCTAssertNil(viewModel.executionMode)
        XCTAssertNil(ChatToolbarSubtitleResolver.subtitle(workspaceName: nil, profileTitle: nil, executionMode: viewModel.executionMode))
    }
}
