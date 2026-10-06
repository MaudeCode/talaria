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

        await viewModel.editQueuedMessage(id: try XCTUnwrap(viewModel.queuedMessagePreviews.first).id)

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

    func testSendNowThatTheRunRefusesKeepsTheComposersFilesInTheComposer() async throws {
        let viewModel = try makeQueueViewModel(steerStatus: { 503 }) { 1 }
        _ = await viewModel.sendMessage("first message")
        try await queue("use the focused test", on: viewModel)
        await viewModel.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")

        await viewModel.sendQueuedMessageNow(id: try XCTUnwrap(viewModel.queuedMessagePreviews.first).id)

        XCTAssertEqual(queueSummary(viewModel), ["use the focused test|0"], "The refused steer queues again without the composer's files")
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["notes.txt"])
    }

    /// TAL-441: a queued copy of a steer whose request failed may still be on the server, which has to give it up first.
    func testAQueuedSteerTheServerMayHoldIsWithdrawnThereBeforeItIsRemoved() async throws {
        var withdrawStatus = 503
        var withdrawnIDs: [String] = []
        let viewModel = try makeQueueViewModel(
            steerStatus: { 503 },
            onWithdraw: { withdrawnIDs.append($0); return withdrawStatus }
        ) { 1 }
        _ = await viewModel.sendMessage("first message")
        let steer = try XCTUnwrap(SlashCommandCatalog.command(named: "steer"))
        _ = await viewModel.executeSlashCommand(steer, args: "maybe delivered")
        let queued = try XCTUnwrap(viewModel.queuedMessagePreviews.first)
        XCTAssertFalse(queued.canSendNow, "Steering it again could deliver it twice")

        await viewModel.removeQueuedMessage(id: queued.id)
        XCTAssertEqual(queueSummary(viewModel), ["maybe delivered|0"], "A failed withdraw keeps it queued")

        withdrawStatus = 200
        await viewModel.editQueuedMessage(id: queued.id)
        XCTAssertTrue(viewModel.queuedMessagePreviews.isEmpty)
        XCTAssertEqual(withdrawnIDs.count, 2)
        XCTAssertEqual(Set(withdrawnIDs).count, 1)
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["maybe delivered"])
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
        steerStatus: @escaping () -> Int = { 200 },
        onWithdraw: @escaping (String) -> Int = { _ in 200 },
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
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-1"}"#, statusCode: steerStatus(), for: request)
            case "/api/chat/steer/withdraw":
                let status = onWithdraw(try apiTestJSONBody(from: request)["steer_id"] as? String ?? "")
                return apiTestJSONResponse(#"{"withdrawn":false}"#, statusCode: status, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
    }
}
