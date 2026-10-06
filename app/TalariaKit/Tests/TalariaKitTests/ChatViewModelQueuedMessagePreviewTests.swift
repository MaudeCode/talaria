import XCTest
@testable import TalariaKit

/// The floating queue chip lists what waits to send after the running response, and each queued
/// message can be sent now, edited or removed (TAL-630).
@MainActor
extension ChatViewModelSendTests {
    func testQueuedMessagePreviewsFollowTheQueueAsItDrains() async throws {
        let streamClient = SpySSEStreamingClient()
        var chatStartCount = 0
        let viewModel = try makeQueueViewModel(streamClient: streamClient) { chatStartCount += 1; return chatStartCount }

        let didStart = await viewModel.sendMessage("first message")
        XCTAssertTrue(didStart)
        XCTAssertTrue(viewModel.queuedMessagePreviews.isEmpty)

        try await queue("second message", on: viewModel)
        await viewModel.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")
        try await queue("third message", on: viewModel)
        XCTAssertEqual(queueSummary(viewModel), ["second message|0", "third message|1"])

        streamClient.emit(.streamEnd)
        try await waitUntil { chatStartCount == 2 }
        XCTAssertEqual(queueSummary(viewModel), ["third message|1"])

        streamClient.emit(.streamEnd)
        try await waitUntil { chatStartCount == 3 }
        XCTAssertTrue(viewModel.queuedMessagePreviews.isEmpty)
    }

    func testRemovingAQueuedMessageDropsItAndItsSavedFiles() async throws {
        let attachmentStore = RecordingSendDraftAttachmentStore()
        let viewModel = try makeQueueViewModel(draftAttachmentStore: attachmentStore) { 1 }
        _ = await viewModel.sendMessage("first message")
        await viewModel.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")
        try await queue("with a file", on: viewModel)
        try await queue("keep me", on: viewModel)

        await viewModel.removeQueuedMessage(id: try XCTUnwrap(viewModel.queuedMessagePreviews.first).id)

        XCTAssertEqual(queueSummary(viewModel), ["keep me|0"])
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty, "A removed message's files do not come back")
        let deletedNames = await attachmentStore.deletedNames()
        XCTAssertEqual(deletedNames, ["saved-1-notes.txt"])
    }

    func testEditingAQueuedMessagePutsItBackInTheComposerWithItsFiles() async throws {
        let viewModel = try makeQueueViewModel { 1 }
        _ = await viewModel.sendMessage("first message")
        await viewModel.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")
        try await queue("fix the typo", on: viewModel)

        viewModel.editQueuedMessage(id: try XCTUnwrap(viewModel.queuedMessagePreviews.first).id)

        XCTAssertTrue(viewModel.queuedMessagePreviews.isEmpty)
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["fix the typo"])
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["notes.txt"])
    }

    func testSendingAQueuedMessageNowSteersItIntoTheRunningReply() async throws {
        var steeredTexts: [String] = []
        let viewModel = try makeQueueViewModel(onSteer: { steeredTexts.append($0) }) { 1 }
        _ = await viewModel.sendMessage("first message")
        try await queue("use the focused test", on: viewModel)
        try await queue("later", on: viewModel)
        let first = try XCTUnwrap(viewModel.queuedMessagePreviews.first)
        XCTAssertTrue(first.canSendNow)

        await viewModel.sendQueuedMessageNow(id: first.id)

        XCTAssertEqual(steeredTexts, ["use the focused test"])
        XCTAssertEqual(queueSummary(viewModel), ["later|0"])
    }

    private func queue(_ text: String, on viewModel: ChatViewModel) async throws {
        let command = try XCTUnwrap(SlashCommandCatalog.command(named: "queue"))
        _ = await viewModel.executeSlashCommand(command, args: text)
    }

    private func queueSummary(_ viewModel: ChatViewModel) -> [String] {
        viewModel.queuedMessagePreviews.map { "\($0.text)|\($0.attachmentCount)" }
    }

    private func makeQueueViewModel(
        streamClient: SpySSEStreamingClient? = nil,
        draftAttachmentStore: RecordingSendDraftAttachmentStore = RecordingSendDraftAttachmentStore(),
        onSteer: @escaping (String) -> Void = { _ in },
        nextStream: @escaping () -> Int
    ) throws -> ChatViewModel {
        try makeViewModel(streamClient: streamClient ?? SpySSEStreamingClient(), draftAttachmentStore: draftAttachmentStore) { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {"filename": "notes.txt", "path": "/tmp/workspace/notes.txt", "size": 5, "mime": "text/plain", "is_image": false}
                """, for: request)
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-\#(nextStream())"}"#, for: request)
            case "/api/chat/steer":
                onSteer(try apiTestJSONBody(from: request)["text"] as? String ?? "")
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-1"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
    }
}
