import XCTest
@testable import TalariaKit

// TAL-434: an open chat catches up with the server after a foreground return and when the
// server announces a change to it, without disturbing a run it is already streaming.
@MainActor
extension ChatViewModelSendTests {
    func testIdleChatCatchesUpWithMessagesAddedWhileItWasAway() async throws {
        let sessionReads = LockedCounter()
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse(
                sessionReads.increment() == 1 ? Self.idleTranscript : Self.transcriptWithReplyFromElsewhere,
                for: request
            )
        }
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Question", "Answer"])

        await viewModel.syncWithServer()

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Question", "Answer", "Asked on the web", "Answered on the web"])
        XCTAssertNil(viewModel.activeStreamID)
    }

    func testIdleChatAttachesToARunStartedElsewhereAndReplaysIt() async throws {
        let streamClient = SpySSEStreamingClient()
        let sessionReads = LockedCounter()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(
                    sessionReads.increment() == 1 ? Self.idleTranscript : Self.transcriptWithRunElsewhere,
                    for: request
                )
            case "/api/chat/stream/status":
                return apiTestJSONResponse(
                    #"{"active": true, "stream_id": "stream-elsewhere", "replay_available": true}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        await viewModel.loadMessages()

        await viewModel.syncWithServer()

        XCTAssertEqual(viewModel.activeStreamID, "stream-elsewhere")
        let streamURL = try XCTUnwrap(streamClient.startedURLs.last)
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: streamURL, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["stream_id"], "stream-elsewhere")
        XCTAssertEqual(query["replay"], "1", "Attaching replays what the run already sent")
        XCTAssertEqual(query["after_seq"], "0", "From the transcript's cursor for that run")
        XCTAssertEqual(viewModel.messages.compactMap(\.content).filter { $0 == "Asked on the web" }.count, 1, "No duplicate prompt")
    }

    func testAnnouncedChangesReloadOnlyWhenTheyConcernThisChat() async throws {
        let sessionReads = LockedCounter()
        let backgroundReads = LockedCounter()
        let viewModel = try makeViewModel { request in
            if request.url?.path == "/api/background/tasks" {
                _ = backgroundReads.increment()
                return apiTestJSONResponse(#"{"session_id":"session-abc","agent_available":true,"tasks":[]}"#, for: request)
            }
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse(
                sessionReads.increment() == 1 ? Self.idleTranscript : Self.transcriptWithReplyFromElsewhere,
                for: request
            )
        }
        await viewModel.loadMessages()

        await viewModel.handleSessionsChange(.changed(reason: "turn_started", sessionID: "another-chat"))
        await viewModel.handleSessionsChange(.changed(reason: "attention_pending", sessionID: nil))
        XCTAssertEqual(sessionReads.count, 1, "Other chats and list-only changes must not reload this chat")
        XCTAssertEqual(backgroundReads.count, 0, "Nor refresh its background work (TAL-372)")

        await viewModel.handleSessionsChange(.changed(reason: "session_done", sessionID: "session-abc"))
        XCTAssertEqual(sessionReads.count, 2)
        XCTAssertEqual(viewModel.messages.last?.content, "Answered on the web")

        await viewModel.handleSessionsChange(.resync)
        XCTAssertEqual(sessionReads.count, 3, "A reconnect may have missed events, so the chat resyncs")
        XCTAssertEqual(backgroundReads.count, 2, "Each change to this chat refreshes its background work too")
    }

    func testARunThisChatIsStreamingIsLeftAlone() async throws {
        let streamClient = SpySSEStreamingClient()
        let sessionReads = LockedCounter()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/session":
                _ = sessionReads.increment()
                return apiTestJSONResponse(Self.idleTranscript, for: request)
            case "/api/background/tasks":
                // TAL-372: background work is separate from the stream and still refreshes.
                return apiTestJSONResponse(#"{"session_id":"session-abc","agent_available":true,"tasks":[]}"#, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        let startedStreams = streamClient.startedURLs.count

        await viewModel.handleSessionsChange(.changed(reason: "turn_started", sessionID: "session-abc"))
        await viewModel.syncWithServer()

        XCTAssertEqual(sessionReads.count, 0, "The live stream already carries this run")
        XCTAssertEqual(streamClient.startedURLs.count, startedStreams)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    private static let idleTranscript = """
    {"session": {"session_id": "session-abc", "title": "Planning", "messages": [
      {"role": "user", "content": "Question", "timestamp": 1770000001, "message_id": "user-1"},
      {"role": "assistant", "content": "Answer", "timestamp": 1770000002, "message_id": "assistant-1"}
    ]}}
    """

    private static let transcriptWithReplyFromElsewhere = """
    {"session": {"session_id": "session-abc", "title": "Planning", "messages": [
      {"role": "user", "content": "Question", "timestamp": 1770000001, "message_id": "user-1"},
      {"role": "assistant", "content": "Answer", "timestamp": 1770000002, "message_id": "assistant-1"},
      {"role": "user", "content": "Asked on the web", "timestamp": 1770000100, "message_id": "user-2"},
      {"role": "assistant", "content": "Answered on the web", "timestamp": 1770000101, "message_id": "assistant-2"}
    ]}}
    """

    private static let transcriptWithRunElsewhere = """
    {"session": {"session_id": "session-abc", "title": "Planning", "active_stream_id": "stream-elsewhere",
      "transcript_seq": {"stream_id": "stream-elsewhere", "seq": 0}, "messages": [
      {"role": "user", "content": "Question", "timestamp": 1770000001, "message_id": "user-1"},
      {"role": "assistant", "content": "Answer", "timestamp": 1770000002, "message_id": "assistant-1"},
      {"role": "user", "content": "Asked on the web", "timestamp": 1770000100, "message_id": "user-2"}
    ]}}
    """
}
