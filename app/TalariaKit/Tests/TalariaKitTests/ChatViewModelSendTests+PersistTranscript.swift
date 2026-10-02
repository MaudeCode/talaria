import SwiftData
import XCTest
@testable import TalariaKit

// TAL-437: a chat left mid-run, or an app backgrounded mid-run, reopens on its partial answer.
@MainActor
extension ChatViewModelSendTests {
    func testLeavingAChatMidRunSavesThePartialAnswerForTheNextOpen() async throws {
        let context = try makeContext()
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
        }
        let didStart = await viewModel.sendMessage("Plan the launch")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Step one: "), lastEventID: "stream-123:1")
        streamClient.emit(.token("draft the brief."), lastEventID: "stream-123:2")

        viewModel.persistTranscript(modelContext: context)

        let cached = try CacheStore.cachedMessages(
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            sessionID: "session-abc",
            in: context
        )
        XCTAssertEqual(cached.compactMap(\.content), ["Plan the launch", "Step one: draft the brief."])
    }

    func testPersistingAnEmptyTranscriptKeepsTheSavedOne() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [ChatMessage(role: "user", content: "Saved", timestamp: 1, messageId: "saved")],
            serverURL: server,
            sessionID: "session-abc",
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        viewModel.persistTranscript(modelContext: context)

        XCTAssertEqual(
            try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).compactMap(\.content),
            ["Saved"]
        )
    }
}
