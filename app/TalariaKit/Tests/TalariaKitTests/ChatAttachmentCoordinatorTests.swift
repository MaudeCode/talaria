import XCTest
@testable import TalariaKit

@MainActor
final class ChatAttachmentCoordinatorTests: APIClientTestCase {
    private var delegateSpies: [ChatAttachmentCoordinatorDelegateSpy] = []

    override func tearDown() {
        DeferredUploadMockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testFirstSendOwnsLocalFilesUntilSessionAdoptionUploadsThem() async throws {
        var requests = 0
        let client = makeClient { request in
            requests += 1
            return apiTestJSONResponse(#"{"path":"/uploads/first.txt","mime":"text/plain","is_image":false}"#, for: request)
        }
        let coordinator = ChatAttachmentCoordinator(client: client, draftAttachmentStore: RecordingAttachmentStore())
        let delegate = ChatAttachmentCoordinatorDelegateSpy()
        delegate.attachmentSessionID = nil
        coordinator.delegate = delegate
        let file = await coordinator.stageAttachment(data: Data("owned fixture bytes".utf8), filename: "first.txt")
        let staged = try XCTUnwrap(file)
        await coordinator.uploadStagedAttachments()
        XCTAssertEqual(requests, 0)
        XCTAssertFalse(coordinator.isUploadingAttachment)
        XCTAssertEqual(coordinator.composerAttachments.map(\.id), [staged.id])
        let pending = coordinator.prepareForSend(localMessageID: "first", keepsPendingAttachments: true)
        XCTAssertEqual(pending.messageAttachments.map(\.name), ["first.txt"])
        XCTAssertTrue(coordinator.composerAttachments.isEmpty, "Send moves ownership to the optimistic row")
        XCTAssertEqual(coordinator.sessionStartupAttachments.map(\.id), [staged.id])
        delegate.attachmentSessionID = "created"
        coordinator.adoptSessionContext(from: "")
        await coordinator.uploadStagedAttachments()
        XCTAssertEqual(requests, 1)
        XCTAssertTrue(coordinator.sessionStartupAttachments.allSatisfy(\.isReadyToSend))
        let post = coordinator.prepareForSend(coordinator.sessionStartupAttachments, localMessageID: "first")
        XCTAssertEqual(post.messageAttachments.map(\.path), ["/uploads/first.txt"])
        for file in post.attachments { coordinator.removePendingAttachment(id: file.id) }
        XCTAssertTrue(coordinator.sessionStartupAttachments.isEmpty)
    }

    func testFailedCreationReturnsEachOwnedLocalFileToTheComposerOnce() async throws {
        let coordinator = ChatAttachmentCoordinator(client: makeClient { request in
            XCTFail("A sessionless file must not upload")
            throw URLError(.badURL)
        }, draftAttachmentStore: RecordingAttachmentStore())
        let delegate = ChatAttachmentCoordinatorDelegateSpy()
        delegate.attachmentSessionID = nil
        coordinator.delegate = delegate
        let file = await coordinator.stageAttachment(data: Data("fixture bytes".utf8), filename: "retry.txt")
        let staged = try XCTUnwrap(file)
        let first = coordinator.prepareForSend(localMessageID: "first", keepsPendingAttachments: true)
        coordinator.restorePendingAttachments(first.attachments)
        coordinator.restorePendingAttachments(first.attachments)
        XCTAssertEqual(coordinator.composerAttachments.map(\.id), [staged.id])
        XCTAssertTrue(coordinator.sessionStartupAttachments.isEmpty)
        XCTAssertEqual(coordinator.pendingAttachments.count, 1)
    }

    func testAttachmentIsVisibleBeforeUploadCompletes() async throws {
        let started = expectation(description: "upload held")
        let state = DeferredUploadState()
        let client = makeDeferredUploadClient { request, transport in
            state.setFirstUploadCompletion {
                transport.complete(with: apiTestJSONResponse(
                    #"{"path":"/tmp/notes.txt","mime":"text/plain","is_image":false}"#,
                    for: request
                ))
            }
            started.fulfill()
        }
        let coordinator = makeCoordinator(client: client)
        let task = Task { await coordinator.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt") }
        await fulfillment(of: [started], timeout: 10)
        XCTAssertEqual(coordinator.pendingAttachments.map(\.name), ["notes.txt"], "Durably staged file must be visible while upload is unresolved")
        let stagedID = coordinator.pendingAttachments.first?.id
        try XCTUnwrap(state.firstUploadCompletion())()
        let uploaded = await task.value
        XCTAssertEqual(uploaded?.id, stagedID, "Upload must adopt the same staged item")
    }

    func testRemovedStagedAttachmentCannotReturnFromLateUpload() async throws {
        let started = expectation(description: "upload held")
        let state = DeferredUploadState()
        let client = makeDeferredUploadClient { request, transport in
            state.setFirstUploadCompletion {
                transport.complete(with: apiTestJSONResponse(#"{"path":"/tmp/notes.txt"}"#, for: request))
            }
            started.fulfill()
        }
        let coordinator = makeCoordinator(client: client)
        let task = Task { await coordinator.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt") }
        await fulfillment(of: [started], timeout: 10)
        if let id = coordinator.pendingAttachments.first?.id { coordinator.removePendingAttachment(id: id) }
        XCTAssertFalse(coordinator.isUploadingAttachment, "Discarding the last intent must unblock the composer before the obsolete reply")
        try XCTUnwrap(state.firstUploadCompletion())()
        _ = await task.value
        XCTAssertTrue(coordinator.pendingAttachments.isEmpty, "A removed local intent cannot be resurrected by an obsolete receipt")
    }

    func testWholeSelectionIsVisibleBeforeSequentialUploadAndNewCapStopsLaterRequests() async throws {
        let started = expectation(description: "first held")
        let state = DeferredUploadState()
        let client = makeDeferredUploadClient { request, transport in
            XCTAssertEqual(state.nextUploadIndex(), 1, "Files beyond the newly learned cap cannot upload")
            state.setFirstUploadCompletion {
                transport.complete(with: apiTestJSONResponse(#"{"path":"/tmp/one.txt","max_attachments_per_message":1}"#, for: request))
            }
            started.fulfill()
        }
        let coordinator = makeCoordinator(client: client)
        for name in ["one.txt", "two.txt", "three.txt"] {
            await coordinator.stageAttachment(data: Data(name.utf8), filename: name)
        }
        let ids = coordinator.pendingAttachments.map(\.id)
        let task = Task { await coordinator.uploadStagedAttachments() }
        await fulfillment(of: [started], timeout: 10)
        XCTAssertEqual(coordinator.pendingAttachments.map(\.name), ["one.txt", "two.txt", "three.txt"])
        XCTAssertTrue(coordinator.pendingAttachments.allSatisfy { !$0.isReadyToSend })
        try XCTUnwrap(state.firstUploadCompletion())()
        await task.value
        XCTAssertEqual(coordinator.pendingAttachments.map(\.id), ids)
        XCTAssertTrue(coordinator.pendingAttachments[0].isReadyToSend)
        XCTAssertFalse(coordinator.pendingAttachments[1].isReadyToSend)
        XCTAssertFalse(coordinator.pendingAttachments[2].isReadyToSend)
    }

    func testFailedUploadRetriesTheSameDurableCopyAndIdentity() async throws {
        var attempts = 0
        let store = RecordingAttachmentStore()
        let client = makeClient { request in
            attempts += 1
            return apiTestJSONResponse(attempts == 1 ? #"{"error":"Try again"}"# : #"{"path":"/tmp/retried.txt"}"#, for: request)
        }
        let coordinator = makeCoordinator(client: client, attachmentStore: store)
        _ = await coordinator.uploadAttachment(data: Data("retry".utf8), filename: "retry.txt")
        let staged = try XCTUnwrap(coordinator.pendingAttachments.first)
        XCTAssertEqual(staged.uploadPhase, .failed("Try again"))
        let result = await coordinator.retryAttachment(id: staged.id)
        XCTAssertEqual(result?.id, staged.id)
        XCTAssertEqual(result?.draftFileName, staged.draftFileName)
        XCTAssertEqual(coordinator.pendingAttachments.count, 1)
        let saved = await store.savedNames()
        XCTAssertEqual(saved.count, 1)
    }

    func testSuspensionFencesLateUploadWithoutDeletingRetryableBytes() async throws {
        for changesContext in [false, true] {
            let started = expectation(description: "held upload")
            let state = DeferredUploadState()
            let store = RecordingAttachmentStore()
            let client = makeDeferredUploadClient { request, transport in
                state.setFirstUploadCompletion { transport.complete(with: apiTestJSONResponse(#"{"path":"/tmp/late.txt"}"#, for: request)) }
                started.fulfill()
            }
            let coordinator = makeCoordinator(client: client, attachmentStore: store)
            let task = Task { await coordinator.uploadAttachment(data: Data("late".utf8), filename: "late.txt") }
            await fulfillment(of: [started], timeout: 10)
            if changesContext { delegateSpies.last?.attachmentSessionID = "replacement-session" } else { coordinator.suspendPendingUploads() }
            try XCTUnwrap(state.firstUploadCompletion())()
            let result = await task.value
            XCTAssertNil(result)
            XCTAssertEqual(coordinator.pendingAttachments.count, 1)
            XCTAssertFalse(coordinator.pendingAttachments[0].isReadyToSend)
            let deleted = await store.deletedNames()
            XCTAssertTrue(deleted.isEmpty)
            XCTAssertFalse(coordinator.isUploadingAttachment)
        }
    }

    func testRejectedSelectionErrorSurvivesTheRemainingUploads() async throws {
        let client = makeClient { request in apiTestJSONResponse(#"{"path":"/tmp/valid.txt"}"#, for: request) }
        let coordinator = makeCoordinator(client: client)
        let rejected = await coordinator.stageAttachment(data: Data(count: PendingAttachment.maximumUploadBytes + 1), filename: "oversized.bin")
        XCTAssertNil(rejected)
        await coordinator.stageAttachment(data: Data("valid".utf8), filename: "valid.txt")
        await coordinator.uploadStagedAttachments()
        XCTAssertEqual(coordinator.pendingAttachments.count, 1)
        XCTAssertTrue(coordinator.pendingAttachments[0].isReadyToSend)
        XCTAssertEqual(coordinator.uploadAttachmentErrorMessage, PendingAttachment.uploadTooLargeMessage(filename: "oversized.bin"), "A successful sibling upload cannot conceal a rejected selection")
    }

    func testStagedPreviewBytesAreBoundedBeforeTheServerCapIsKnown() async throws {
        var uploads = 0
        let client = makeClient { request in
            uploads += 1
            let filename = try Self.multipartFilename(from: request)
            return apiTestJSONResponse("{\"path\":\"/tmp/\(filename)\",\"mime\":\"image/png\",\"is_image\":true}", for: request)
        }
        let coordinator = makeCoordinator(client: client)
        var image = try XCTUnwrap(Self.imageData())
        image.append(Data(count: 5 * 1_024 * 1_024))
        for filename in ["one.png", "two.png", "three.png"] {
            await coordinator.stageAttachment(data: image, filename: filename, previewData: image)
        }
        XCTAssertEqual(uploads, 0, "Staging must not start the upload")
        XCTAssertEqual(coordinator.pendingAttachments.count, 3, "The cache budget cannot reject local file intent")
        XCTAssertLessThanOrEqual(coordinator.pendingAttachments.compactMap(\.thumbnailData).reduce(0) { $0 + $1.count }, 8 * 1_024 * 1_024)
        XCTAssertTrue(coordinator.pendingAttachments.allSatisfy { $0.draftFileName != nil })
        await coordinator.uploadStagedAttachments()
        XCTAssertEqual(uploads, 3)
        XCTAssertTrue(coordinator.pendingAttachments.allSatisfy(\.isReadyToSend))
        XCTAssertLessThanOrEqual(coordinator.pendingAttachments.compactMap(\.thumbnailData).reduce(0) { $0 + $1.count }, 8 * 1_024 * 1_024)
    }

    func testReorderedUploadReceiptsCannotExceedTheLearnedServerCap() async throws {
        let held = expectation(description: "first request held")
        let state = DeferredUploadState()
        let client = makeDeferredUploadClient { request, transport in
            let index = state.nextUploadIndex()
            let response = apiTestJSONResponse("{\"path\":\"/tmp/file-\(index).txt\",\"max_attachments_per_message\":1}", for: request)
            if index == 1 {
                state.setFirstUploadCompletion { transport.complete(with: response) }
                held.fulfill()
            } else { transport.complete(with: response) }
        }
        let coordinator = makeCoordinator(client: client)
        let first = Task { await coordinator.uploadAttachment(data: Data("one".utf8), filename: "one.txt") }
        await fulfillment(of: [held], timeout: 10)
        _ = await coordinator.uploadAttachment(data: Data("two".utf8), filename: "two.txt")
        XCTAssertFalse(coordinator.pendingAttachments[1].isReadyToSend, "A receipt outside the authoritative cap cannot become sendable")
        try XCTUnwrap(state.firstUploadCompletion())()
        _ = await first.value
        XCTAssertEqual(coordinator.pendingAttachments.count, 2, "Keep rejected local intents available for removal or retry")
        XCTAssertEqual(coordinator.pendingAttachments.filter(\.isReadyToSend).count, 1)
    }

    func testUploadSuccessAddsPendingAttachmentAndPreparesLocalPreview() async throws {
        let imageData = try XCTUnwrap(Self.imageData())
        var uploadedFilename: String?
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/upload")
            uploadedFilename = try Self.multipartFilename(from: request)
            return apiTestJSONResponse(
                """
                {
                  "filename": "photo.png",
                  "path": "/tmp/workspace/photo.png",
                  "size": \(imageData.count),
                  "mime": "image/png",
                  "is_image": true
                }
                """,
                for: request
            )
        }
        let coordinator = makeCoordinator(client: client)

        await coordinator.uploadAttachment(data: imageData, filename: "/tmp/photo.png", previewData: imageData)

        XCTAssertEqual(uploadedFilename, "photo.png")
        XCTAssertNil(coordinator.uploadAttachmentErrorMessage)
        XCTAssertFalse(coordinator.isUploadingAttachment)
        let attachment = try XCTUnwrap(coordinator.pendingAttachments.first)
        XCTAssertEqual(attachment.name, "photo.png")
        XCTAssertEqual(attachment.path, "/tmp/workspace/photo.png")
        XCTAssertEqual(attachment.mime, "image/png")
        XCTAssertEqual(attachment.size, imageData.count)
        XCTAssertTrue(attachment.isImage)
        XCTAssertNotNil(attachment.thumbnailData)

        let preparation = coordinator.prepareForSend(localMessageID: "local-message")

        XCTAssertTrue(coordinator.pendingAttachments.isEmpty)
        XCTAssertEqual(preparation.attachments.count, 1)
        XCTAssertEqual(preparation.messageAttachments.first?.path, "/tmp/workspace/photo.png")
        XCTAssertEqual(preparation.apiPayloads?.count, 1)
        XCTAssertNotNil(coordinator.localAttachmentPreviews["local-message"]?["/tmp/workspace/photo.png"])
    }

    func testUploadFailurePreservesExistingPendingAttachment() async throws {
        var uploadCount = 0
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/upload")
            uploadCount += 1

            if uploadCount == 1 {
                return apiTestJSONResponse(
                    """
                    {
                      "filename": "notes.txt",
                      "path": "/tmp/workspace/notes.txt",
                      "size": 5,
                      "mime": "text/plain",
                      "is_image": false
                    }
                    """,
                    for: request
                )
            }

            return apiTestJSONResponse(#"{"error":"Upload failed."}"#, for: request)
        }
        let coordinator = makeCoordinator(client: client)

        await coordinator.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")
        await coordinator.uploadAttachment(data: Data("large".utf8), filename: "large.bin")

        XCTAssertEqual(uploadCount, 2)
        XCTAssertEqual(coordinator.pendingAttachments.count, 2)
        XCTAssertEqual(coordinator.pendingAttachments.first?.name, "notes.txt")
        XCTAssertEqual(coordinator.pendingAttachments.last?.uploadPhase, .failed("Upload failed."))
        XCTAssertEqual(coordinator.uploadAttachmentErrorMessage, "Upload failed.")
    }

    func testDraftCopyFailureStopsBeforeNetworkUpload() async {
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            return apiTestJSONResponse(#"{"error":"unexpected upload"}"#, for: request)
        }
        let store = RecordingAttachmentStore(saveError: CocoaError(.fileWriteOutOfSpace))
        let coordinator = makeCoordinator(client: client, attachmentStore: store)

        let uploaded = await coordinator.uploadAttachment(
            data: Data("notes".utf8),
            filename: "notes.txt"
        )

        XCTAssertNil(uploaded)
        XCTAssertEqual(requestCount, 0)
        XCTAssertTrue(coordinator.pendingAttachments.isEmpty)
        XCTAssertEqual(
            coordinator.uploadAttachmentErrorMessage,
            "Could not save the attachment on this device."
        )
    }

    func testConcurrentUploadsKeepUploadingStateUntilAllUploadsFinish() async throws {
        let firstUploadStarted = expectation(description: "first upload started")
        let uploadState = DeferredUploadState()

        let client = makeDeferredUploadClient { request, protocolClient in
            XCTAssertEqual(request.url?.path, "/api/upload")
            let filename = try Self.multipartFilename(from: request)
            let uploadIndex = uploadState.nextUploadIndex()

            let response = apiTestJSONResponse(
                """
                {
                  "filename": "\(filename)",
                  "path": "/tmp/workspace/\(filename)",
                  "size": 4,
                  "mime": "text/plain",
                  "is_image": false
                }
                """,
                for: request
            )

            if uploadIndex == 1 {
                uploadState.setFirstUploadCompletion {
                    protocolClient.complete(with: response)
                }
                firstUploadStarted.fulfill()
                return
            }

            protocolClient.complete(with: response)
        }
        let coordinator = makeCoordinator(client: client)

        let firstUpload = Task {
            await coordinator.uploadAttachment(data: Data("one".utf8), filename: "one.txt")
        }
        await fulfillment(of: [firstUploadStarted], timeout: 10)
        XCTAssertTrue(coordinator.isUploadingAttachment)

        let secondUpload = Task {
            await coordinator.uploadAttachment(data: Data("two".utf8), filename: "two.txt")
        }
        await secondUpload.value

        XCTAssertTrue(coordinator.isUploadingAttachment)
        let finishFirst = try XCTUnwrap(
            uploadState.firstUploadCompletion(),
            "Expected the first upload completion to be deferred."
        )
        finishFirst()
        await firstUpload.value

        XCTAssertFalse(coordinator.isUploadingAttachment)
        XCTAssertEqual(coordinator.pendingAttachments.map(\.name), ["one.txt", "two.txt"])
    }

    func testRemovePendingAttachmentRemovesOnlyMatchingAttachment() async throws {
        let client = makeClient { request in
            let filename = try apiTestMultipartFilename(from: request)
            return apiTestJSONResponse(
                """
                {
                  "filename": "\(filename)",
                  "path": "/tmp/workspace/\(filename)",
                  "size": 4,
                  "mime": "text/plain",
                  "is_image": false
                }
                """,
                for: request
            )
        }
        let coordinator = makeCoordinator(client: client)

        await coordinator.uploadAttachment(data: Data("one".utf8), filename: "one.txt")
        await coordinator.uploadAttachment(data: Data("two".utf8), filename: "two.txt")
        let firstID = try XCTUnwrap(coordinator.pendingAttachments.first?.id)

        coordinator.removePendingAttachment(id: firstID)

        XCTAssertEqual(coordinator.pendingAttachments.map(\.name), ["two.txt"])
    }

    func testTranscriptSameServerRemoteMediaUsesAuthenticatedSession() async throws {
        let mediaData = Data([0x01, 0x02, 0x03])
        let remoteURL = try XCTUnwrap(URL(string: "https://example.test/generated/media/image.png?variant=full"))
        let client = makeAuthenticatedMediaClient { request in
            XCTAssertEqual(request.url, remoteURL)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Test-Session"), "authenticated")
            return (Self.okResponse(for: request, contentType: nil), mediaData)
        }
        let coordinator = makeCoordinator(client: client)

        let thumbnail = await coordinator.transcriptMediaThumbnailData(
            for: TranscriptMediaReference(url: remoteURL.absoluteString, name: "image.png", mediaKind: .image)
        )

        XCTAssertEqual(thumbnail, mediaData)
    }

    /// TAL-186: the server's media URL loads as sent, under the base URL's path, with the session's credentials.
    func testTranscriptServerMediaLoadsTheServerURLUnderTheBasePath() async throws {
        let mediaData = try XCTUnwrap(Self.imageData())
        let mediaPath = "/Users/hermes/.hermes/browser_screenshots/example (1).png"
        let client = makeAuthenticatedMediaClient(baseURL: "https://example.test/talaria") { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/talaria/api/media")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Test-Session"), "authenticated")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["session_id"], "session-abc")
            XCTAssertEqual(query["path"], mediaPath)
            return (Self.okResponse(for: request, contentType: "image/png"), mediaData)
        }
        let coordinator = makeCoordinator(client: client)

        let thumbnail = await coordinator.transcriptMediaThumbnailData(for: TranscriptMediaReference(
            url: "./api/media?path=%2FUsers%2Fhermes%2F.hermes%2Fbrowser_screenshots%2Fexample%20(1).png&session_id=session-abc",
            name: "example (1).png",
            mime: "image/png",
            mediaKind: .image
        ))

        XCTAssertNotNil(thumbnail)
    }

    func testTranscriptServerAudioMediaLoadsItsBytes() async throws {
        let mediaData = Data("audio-bytes".utf8)
        let client = makeAuthenticatedMediaClient { request in
            XCTAssertEqual(request.url?.absoluteString, "https://example.test/api/media?path=%2Ftmp%2Fgenerated%2Fclip.mp3&session_id=session-abc")
            return (Self.okResponse(for: request, contentType: "audio/mpeg"), mediaData)
        }
        let coordinator = makeCoordinator(client: client)

        let data = await coordinator.transcriptMediaData(for: TranscriptMediaReference(
            url: "./api/media?path=%2Ftmp%2Fgenerated%2Fclip.mp3&session_id=session-abc",
            name: "clip.mp3",
            mime: "audio/mpeg",
            mediaKind: .audio
        ))

        XCTAssertEqual(data, mediaData)
    }

    func testTranscriptExternalRemoteVideoUsesPublicMediaSession() async throws {
        let mediaData = Data("video-bytes".utf8)
        let remoteURL = try XCTUnwrap(URL(string: "https://cdn.example.test/generated/movie.mp4"))
        let client = makeAuthenticatedMediaClient { request in
            XCTAssertEqual(request.url, remoteURL)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Test-Session"), "public")
            return (Self.okResponse(for: request, contentType: "video/mp4"), mediaData)
        }
        let coordinator = makeCoordinator(client: client)

        let data = await coordinator.transcriptMediaData(
            for: TranscriptMediaReference(url: remoteURL.absoluteString, name: "movie.mp4", mediaKind: .video)
        )

        XCTAssertEqual(data, mediaData)
    }

    func testTranscriptMediaWithANonHTTPSchemeRequestsNothing() async {
        var requestCount = 0
        let client = makeAuthenticatedMediaClient { request in
            requestCount += 1
            return (Self.okResponse(for: request, contentType: nil), Data("unexpected".utf8))
        }
        let coordinator = makeCoordinator(client: client)

        let data = await coordinator.transcriptMediaData(
            for: TranscriptMediaReference(url: "file:///tmp/generated/clip.mp3", name: "clip.mp3", mediaKind: .audio)
        )

        XCTAssertNil(data)
        XCTAssertEqual(requestCount, 0)
    }

    private static func okResponse(for request: URLRequest, contentType: String?) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: contentType.map { ["Content-Type": $0] }
        )!
    }

    func testUploadCarriesDraftFileNameIntoPendingAttachment() async throws {
        let client = makeClient { request in
            let filename = try Self.multipartFilename(from: request)
            return apiTestJSONResponse(
                """
                {
                  "filename": "\(filename)",
                  "path": "/tmp/workspace/\(filename)",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false
                }
                """,
                for: request
            )
        }
        let store = RecordingAttachmentStore()
        let coordinator = makeCoordinator(client: client, attachmentStore: store)

        let uploaded = await coordinator.uploadAttachment(
            data: Data("notes".utf8),
            filename: "notes.txt"
        )

        XCTAssertEqual(uploaded?.draftFileName, "saved-1-notes.txt")
        XCTAssertEqual(coordinator.pendingAttachments.first?.draftFileName, "saved-1-notes.txt")
        let savedNames = await store.savedNames()
        XCTAssertEqual(savedNames, ["saved-1-notes.txt"])
    }

    func testStandaloneUploadNeverCarriesADraftFileName() async throws {
        let client = makeClient { request in
            let filename = try Self.multipartFilename(from: request)
            return apiTestJSONResponse(
                """
                {
                  "filename": "\(filename)",
                  "path": "/tmp/workspace/\(filename)",
                  "size": 5,
                  "mime": "audio/m4a",
                  "is_image": false
                }
                """,
                for: request
            )
        }
        let coordinator = makeCoordinator(client: client)

        let uploaded = await coordinator.uploadStandaloneAttachment(
            data: Data("audio".utf8),
            filename: "clip.m4a"
        )

        XCTAssertNil(uploaded?.draftFileName)
        XCTAssertTrue(coordinator.pendingAttachments.isEmpty)
    }

    func testReuploadDraftAttachmentPreservesDraftIdentity() async throws {
        let record = ChatDraftAttachment(
            id: UUID(),
            name: "notes.txt",
            mime: "text/plain",
            size: 5,
            isImage: false,
            file: "abc-notes.txt"
        )
        let client = makeClient { request in
            let filename = try Self.multipartFilename(from: request)
            return apiTestJSONResponse(
                """
                {
                  "filename": "\(filename)",
                  "path": "/tmp/workspace/\(filename)",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false
                }
                """,
                for: request
            )
        }
        let coordinator = makeCoordinator(client: client)

        let restored = await coordinator.reuploadDraftAttachment(
            data: Data("notes".utf8),
            draftAttachment: record
        )

        XCTAssertEqual(restored?.id, record.id)
        XCTAssertEqual(restored?.draftFileName, "abc-notes.txt")
        XCTAssertEqual(restored?.path, "/tmp/workspace/notes.txt")
        XCTAssertNil(coordinator.uploadAttachmentErrorMessage)
        XCTAssertEqual(coordinator.pendingAttachments.map(\.id), [record.id])
    }

    func testReuploadDraftAttachmentFailureStaysQuiet() async throws {
        let record = ChatDraftAttachment(
            id: UUID(),
            name: "notes.txt",
            mime: "text/plain",
            size: 5,
            isImage: false,
            file: "abc-notes.txt"
        )
        let client = makeClient { request in
            apiTestJSONResponse(#"{"error":"Upload failed."}"#, for: request)
        }
        let coordinator = ChatAttachmentCoordinator(client: client)
        let delegate = ChatAttachmentCoordinatorDelegateSpy()
        delegateSpies.append(delegate)
        coordinator.delegate = delegate

        let restored = await coordinator.reuploadDraftAttachment(
            data: Data("notes".utf8),
            draftAttachment: record
        )

        // Restore failures must not surface a per-item banner or delegate
        // error; the caller reports in aggregate and keeps the draft record.
        XCTAssertNil(restored)
        XCTAssertEqual(coordinator.pendingAttachments.count, 1)
        XCTAssertFalse(coordinator.pendingAttachments[0].isReadyToSend)
        XCTAssertNil(coordinator.uploadAttachmentErrorMessage)
        XCTAssertTrue(delegate.failedErrors.isEmpty)
    }

    /// TAL-635: a draft saved before the server's attachment cap can hold more; restoring stops at
    /// the cap and leaves the rest in the draft, quietly, so a send never loses one.
    func testReuploadDraftAttachmentStopsAtTheServerCap() async throws {
        func record(_ name: String) -> ChatDraftAttachment {
            ChatDraftAttachment(id: UUID(), name: name, mime: "text/plain", size: 5, isImage: false, file: "abc-\(name)")
        }
        var uploads = 0
        let client = makeClient { request in
            uploads += 1
            return apiTestJSONResponse(
                """
                {
                  "filename": "notes-\(uploads).txt",
                  "path": "/tmp/workspace/notes-\(uploads).txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true,
                  "max_attachments_per_message": 1
                }
                """,
                for: request
            )
        }
        let coordinator = makeCoordinator(client: client)

        let first = await coordinator.reuploadDraftAttachment(data: Data("a".utf8), draftAttachment: record("a.txt"))
        let second = await coordinator.reuploadDraftAttachment(data: Data("b".utf8), draftAttachment: record("b.txt"))

        XCTAssertNotNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(uploads, 1, "The attachment past the cap must not be uploaded")
        XCTAssertEqual(coordinator.pendingAttachments.count, 1)
        XCTAssertNil(coordinator.uploadAttachmentErrorMessage)
    }

    private func makeCoordinator(
        client: APIClient,
        attachmentStore: (any ChatDraftAttachmentStoring)? = nil
    ) -> ChatAttachmentCoordinator {
        let coordinator = ChatAttachmentCoordinator(
            client: client,
            draftAttachmentStore: attachmentStore ?? RecordingAttachmentStore()
        )
        let delegate = ChatAttachmentCoordinatorDelegateSpy()
        delegateSpies.append(delegate)
        coordinator.delegate = delegate
        return coordinator
    }

    private func makeAuthenticatedMediaClient(
        baseURL: String = "https://example.test",
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> APIClient {
        MockURLProtocol.requestHandler = handler

        let authenticatedConfiguration = URLSessionConfiguration.ephemeral
        authenticatedConfiguration.protocolClasses = [MockURLProtocol.self]
        authenticatedConfiguration.httpAdditionalHeaders = ["X-Talaria-Test-Session": "authenticated"]

        let publicConfiguration = URLSessionConfiguration.ephemeral
        publicConfiguration.protocolClasses = [MockURLProtocol.self]
        publicConfiguration.httpAdditionalHeaders = ["X-Talaria-Test-Session": "public"]

        return APIClient(
            baseURL: URL(string: baseURL)!,
            session: URLSession(configuration: authenticatedConfiguration),
            publicMediaSession: URLSession(configuration: publicConfiguration)
        )
    }

    private func makeDeferredUploadClient(
        handler: @escaping (URLRequest, DeferredUploadMockURLProtocol) throws -> Void
    ) -> APIClient {
        DeferredUploadMockURLProtocol.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredUploadMockURLProtocol.self]
        return APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: URLSession(configuration: configuration)
        )
    }

    private static func imageData() -> Data? {
        TestImages.pngData(width: 24, height: 24)
    }

    private static func multipartFilename(from request: URLRequest) throws -> String {
        let data = try XCTUnwrap(apiTestBodyData(from: request))
        let marker = Data("filename=\"".utf8)
        let quote = Data("\"".utf8)
        let markerRange = try XCTUnwrap(data.range(of: marker))
        let filenameStart = markerRange.upperBound
        let filenameEnd = try XCTUnwrap(data[filenameStart...].range(of: quote)).lowerBound
        return String(decoding: data[filenameStart..<filenameEnd], as: UTF8.self)
    }
}

private actor RecordingAttachmentStore: ChatDraftAttachmentStoring {
    private var bytes: [String: Data] = [:]
    private let saveError: Error?
    private var saves: [String] = []
    private var deletes: [String] = []

    init(saveError: Error? = nil) {
        self.saveError = saveError
    }

    func save(data: Data, suggestedFilename: String) async throws -> String {
        if let saveError {
            throw saveError
        }
        let fileName = "saved-\(saves.count + 1)-\(URL(fileURLWithPath: suggestedFilename).lastPathComponent)"
        saves.append(fileName)
        bytes[fileName] = data
        return fileName
    }

    func data(named fileName: String) async throws -> Data {
        bytes[fileName] ?? Data()
    }

    func delete(named fileName: String) async {
        deletes.append(fileName)
    }

    func sweep(keepingReferenced fileNames: Set<String>, olderThan maxAge: TimeInterval) async {}

    func savedNames() -> [String] {
        saves
    }

    func deletedNames() -> [String] {
        deletes
    }
}

final class DeferredUploadMockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest, DeferredUploadMockURLProtocol) throws -> Void)?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let requestHandler = Self.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            try requestHandler(request, self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    func complete(with response: (HTTPURLResponse, Data)) {
        client?.urlProtocol(self, didReceive: response.0, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.1)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class DeferredUploadState {
    private let lock = NSLock()
    private var uploadCount = 0
    private var firstCompletion: (() -> Void)?

    func nextUploadIndex() -> Int {
        lock.lock()
        defer { lock.unlock() }
        uploadCount += 1
        return uploadCount
    }

    func observedUploadCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return uploadCount
    }

    func setFirstUploadCompletion(_ completion: @escaping () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        firstCompletion = completion
    }

    func firstUploadCompletion() -> (() -> Void)? {
        lock.lock()
        defer { lock.unlock() }
        return firstCompletion
    }
}

@MainActor
private final class ChatAttachmentCoordinatorDelegateSpy: ChatAttachmentCoordinatorDelegate {
    var attachmentSessionID: String? = "session-abc"
    var attachmentIsViewingCachedData = false
    private(set) var failedErrors: [Error] = []

    func attachmentCoordinatorWillUpload() {}

    func attachmentCoordinatorDidFail(_ error: Error) {
        failedErrors.append(error)
    }
}
