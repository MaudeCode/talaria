import XCTest
@testable import TalariaKit

/// The floating queue chip lists what waits to send after the running response (TAL-630).
@MainActor
extension ChatViewModelSendTests {
    func testQueuedMessagePreviewsFollowTheQueueAsItDrains() async throws {
        let streamClient = SpySSEStreamingClient()
        var chatStartCount = 0
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {"filename": "notes.txt", "path": "/tmp/workspace/notes.txt", "size": 5, "mime": "text/plain", "is_image": false}
                """, for: request)
            case "/api/chat/start":
                chatStartCount += 1
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-\#(chatStartCount)"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        let queueCommand = try XCTUnwrap(SlashCommandCatalog.command(named: "queue"))

        let didStart = await viewModel.sendMessage("first message")
        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.queuedMessagePreviews, [])

        _ = await viewModel.executeSlashCommand(queueCommand, args: "second message")
        await viewModel.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")
        _ = await viewModel.executeSlashCommand(queueCommand, args: "third message")
        XCTAssertEqual(viewModel.queuedMessagePreviews, [
            QueuedMessagePreview(text: "second message", attachmentCount: 0),
            QueuedMessagePreview(text: "third message", attachmentCount: 1),
        ])

        streamClient.emit(.streamEnd)
        try await waitUntil { chatStartCount == 2 }
        XCTAssertEqual(viewModel.queuedMessagePreviews, [
            QueuedMessagePreview(text: "third message", attachmentCount: 1),
        ])

        streamClient.emit(.streamEnd)
        try await waitUntil { chatStartCount == 3 }
        XCTAssertEqual(viewModel.queuedMessagePreviews, [])
    }
}
