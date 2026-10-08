import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testUploadAttachmentRejectsOversizedFileBeforeRequest() async throws {
        var didRequestUpload = false
        let viewModel = try makeViewModel { request in
            didRequestUpload = true
            XCTFail("Oversized attachment should not reach \(request.url?.path ?? "unknown path")")
            throw URLError(.badURL)
        }

        await viewModel.uploadAttachment(
            data: Data(count: PendingAttachment.maximumUploadBytes + 1),
            filename: "too-large.mov"
        )

        XCTAssertFalse(didRequestUpload)
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)
        XCTAssertEqual(
            viewModel.uploadAttachmentErrorMessage,
            "too-large.mov is too large. Attachments must be 20 MB or smaller."
        )
    }

    @MainActor
    func testUploadAttachmentDownsamplesImagePreviewButUploadsOriginalData() async throws {
        let originalData = try makeJPEGData(size: CGSize(width: 1_600, height: 1_200))
        var uploadedBody: Data?
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/upload")

            let body = try XCTUnwrap(apiTestBodyData(from: request))
            uploadedBody = body
            XCTAssertNotNil(body.range(of: originalData))

            return apiTestJSONResponse("""
            {
              "filename": "large.jpg",
              "path": "/tmp/workspace/large.jpg",
              "size": \(originalData.count),
              "mime": "image/jpeg",
              "is_image": true,
              "named_in_prompt": true
            }
            """, for: request)
        }

        await viewModel.uploadAttachment(data: originalData, filename: "large.jpg", previewData: originalData)

        let attachment = try XCTUnwrap(viewModel.pendingAttachments.first)
        let thumbnailData = try XCTUnwrap(attachment.thumbnailData)
        XCTAssertNotNil(uploadedBody)
        XCTAssertNotEqual(thumbnailData, originalData)
        XCTAssertGreaterThan(try maxPixelDimension(in: originalData), ImagePreviewDownsampler.attachmentMaxPixelSize)
        XCTAssertLessThanOrEqual(
            try maxPixelDimension(in: thumbnailData),
            ImagePreviewDownsampler.attachmentMaxPixelSize
        )
    }

    func testImagePreviewDownsamplerSkipsWorkWhenCallerIsCancelled() async throws {
        let originalData = try makeJPEGData(size: CGSize(width: 1_600, height: 1_200))
        let task = Task<Data?, Never> {
            while !Task.isCancelled {
                await Task.yield()
            }

            return await ImagePreviewDownsampler.previewDataAsync(
                from: originalData,
                maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
            )
        }

        task.cancel()

        let thumbnailData = await task.value

        XCTAssertNil(thumbnailData)
    }

    @MainActor
    func testUploadAttachmentFailurePreservesExistingPendingAttachment() async throws {
        var uploadCount = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/upload")
            uploadCount += 1

            if uploadCount == 1 {
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true
                }
                """, for: request)
            }

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 413,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/plain"]
            )
            return (try XCTUnwrap(response), Data("too large".utf8))
        }

        await viewModel.uploadAttachment(data: Data("hello".utf8), filename: "notes.txt")
        XCTAssertEqual(viewModel.pendingAttachments.count, 1)

        await viewModel.uploadAttachment(data: Data("large".utf8), filename: "large.bin")

        XCTAssertEqual(viewModel.pendingAttachments.count, 1)
        XCTAssertEqual(viewModel.pendingAttachments.first?.name, "notes.txt")
        XCTAssertNotNil(viewModel.uploadAttachmentErrorMessage)
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testDuplicateUploadFilenamesUseDistinctServerPathsAndLocalPreviews() async throws {
        let imageA = try makeJPEGData(size: CGSize(width: 12, height: 12))
        let imageB = try makeJPEGData(size: CGSize(width: 16, height: 12))
        var uploadedFilenames: [String] = []
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/upload":
                let filename = try apiTestMultipartFilename(from: request)
                uploadedFilenames.append(filename)
                return apiTestJSONResponse("""
                {
                  "filename": "\(filename)",
                  "path": "/tmp/workspace/\(filename)",
                  "size": 4,
                  "mime": "image/jpeg",
                  "is_image": true,
                  "named_in_prompt": true
                }
                """, for: request)
            case "/api/chat/start":
                let body = try apiTestJSONBody(from: request)
                let attachmentPayloads = try XCTUnwrap(body["attachments"] as? [[String: Any]])
                let paths = attachmentPayloads.compactMap { $0["path"] as? String }

                XCTAssertEqual(attachmentPayloads.compactMap { $0["name"] as? String }, [
                    "shared-image.jpg",
                    "shared-image.jpg"
                ])
                XCTAssertEqual(paths.count, 2)
                XCTAssertEqual(Set(paths).count, 2)

                // The bare draft: the server names the attached files in the prompt (TAL-276), so the
                // App adding its own `[Attached files: …]` line sent it to the agent twice (TAL-635).
                XCTAssertEqual(body["message"] as? String, "Compare these")

                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(data: Data("image-a".utf8), filename: "shared-image.jpg", previewData: imageA)
        await viewModel.uploadAttachment(data: Data("image-b".utf8), filename: "shared-image.jpg", previewData: imageB)

        XCTAssertEqual(uploadedFilenames.count, 2)
        XCTAssertEqual(uploadedFilenames[0], "shared-image.jpg")
        XCTAssertTrue(uploadedFilenames[1].hasPrefix("shared-image-"))
        XCTAssertTrue(uploadedFilenames[1].hasSuffix(".jpg"))
        XCTAssertNotEqual(uploadedFilenames[0], uploadedFilenames[1])
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["shared-image.jpg", "shared-image.jpg"])
        XCTAssertEqual(Set(viewModel.pendingAttachments.map(\.path)).count, 2)

        let didStart = await viewModel.sendMessage("Compare these")

        XCTAssertTrue(didStart)
        let message = try XCTUnwrap(viewModel.messages.first)
        let messageID = try XCTUnwrap(message.messageId)
        let paths = try XCTUnwrap(message.attachments?.compactMap(\.path))
        let previews = try XCTUnwrap(viewModel.localAttachmentPreviews[messageID])
        XCTAssertEqual(Set(previews.keys), Set(paths))
        XCTAssertEqual(previews[paths[0]], imageA)
        XCTAssertEqual(previews[paths[1]], imageB)
    }
}

// MARK: - TAL-158: attachment-only sends

@MainActor
extension ChatViewModelSendTests {
    /// Uploads one file, then sends with an empty draft. The send must reach
    /// `/api/chat/start` carrying the WebUI's synthesized message plus the file.
    func testTextlessSendWithAttachmentSynthesizesMessage() async throws {
        var startedMessage: String?
        var startedAttachmentPaths: [String] = []
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true
                }
                """, for: request)
            case "/api/chat/start":
                let body = try apiTestJSONBody(from: request)
                startedMessage = body["message"] as? String
                startedAttachmentPaths = (body["attachments"] as? [[String: Any]] ?? [])
                    .compactMap { $0["path"] as? String }
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(data: Data("hello".utf8), filename: "notes.txt")
        XCTAssertEqual(viewModel.pendingAttachments.count, 1)

        let didStart = await viewModel.sendMessage("   ")

        XCTAssertTrue(didStart)
        // An attachment-only send has no text; the server names the file (TAL-276, TAL-635).
        XCTAssertEqual(startedMessage, "")
        XCTAssertEqual(startedAttachmentPaths, ["/tmp/workspace/notes.txt"])
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)
        // The optimistic row carries exactly what the server will store, so the
        // bubble looks the same before and after a reload.
        XCTAssertEqual(viewModel.messages.first?.content, startedMessage)
        XCTAssertEqual(viewModel.messages.first?.attachments?.compactMap(\.path), startedAttachmentPaths)
    }

    /// TAL-635: a server from before `named_in_prompt` does not name attached files in the prompt,
    /// so the App still names them in the text for it.
    func testSendNamesFilesInTheTextForAServerThatDoesNotNameThem() async throws {
        var startedMessage: String?
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false
                }
                """, for: request)
            case "/api/chat/start":
                startedMessage = try apiTestJSONBody(from: request)["message"] as? String
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(data: Data("hello".utf8), filename: "notes.txt")
        let didStart = await viewModel.sendMessage("Summarize this")

        XCTAssertTrue(didStart)
        XCTAssertEqual(startedMessage, "Summarize this\n\n[Attached files: /tmp/workspace/notes.txt]")
    }

    /// TAL-635: the server keeps at most `max_attachments_per_message` on a message, so one more
    /// is refused when it is staged instead of being dropped on send.
    func testStagingPastTheServerAttachmentCapIsRefused() async throws {
        var uploads = 0
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                uploads += 1
                return apiTestJSONResponse("""
                {
                  "filename": "notes-\(uploads).txt",
                  "path": "/tmp/workspace/notes-\(uploads).txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true,
                  "max_attachments_per_message": 2
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(data: Data("a".utf8), filename: "notes-a.txt")
        await viewModel.uploadAttachment(data: Data("b".utf8), filename: "notes-b.txt")
        let third = await viewModel.uploadAttachment(data: Data("c".utf8), filename: "notes-c.txt")

        XCTAssertNil(third)
        XCTAssertEqual(uploads, 2, "The third file must not be uploaded")
        XCTAssertEqual(viewModel.pendingAttachments.count, 2)
        XCTAssertEqual(viewModel.uploadAttachmentErrorMessage, "A message can carry up to 2 attachments.")
    }

    func testTextlessSendWithoutAttachmentsIsRejectedBeforeAnyRequest() async throws {
        let viewModel = try makeViewModel { request in
            XCTFail("Empty send should not reach \(request.url?.path ?? "unknown path")")
            throw URLError(.badURL)
        }

        let didStart = await viewModel.sendMessage("   \n ")

        XCTAssertFalse(didStart)
        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testFailedTextlessSendRestoresStagedAttachment() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true
                }
                """, for: request)
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","error":"server unreachable"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(data: Data("hello".utf8), filename: "notes.txt")

        let didStart = await viewModel.sendMessage("")

        XCTAssertFalse(didStart)
        XCTAssertEqual(viewModel.pendingAttachments.map(\.path), ["/tmp/workspace/notes.txt"])
    }

    /// Steering carries no files, so a steer with text and staged files queues them together rather than
    /// steering the text and leaving the files behind for an unrelated later message (TAL-660).
    func testSteerWithTextAndStagedFilesQueuesThemTogether() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true
                }
                """, for: request)
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-123"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStartRun = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStartRun)
        await viewModel.uploadAttachment(data: Data("hello".utf8), filename: "notes.txt")

        let result = await viewModel.submitStreamingMessage("Read the notes", behavior: .steer)

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty, "The steer left the staged files behind")
        XCTAssertEqual(viewModel.queuedMessagePreviews.map(\.text), ["Read the notes"])
        XCTAssertEqual(viewModel.queuedMessagePreviews.first?.attachmentNames.count, 1)
    }

    /// A textless send during a run cannot steer — steering carries no files —
    /// so it queues, and the drain replays it with the synthesized message.
    func testTextlessSendDuringRunQueuesAndDrainsWithAttachment() async throws {
        let streamClient = SpySSEStreamingClient()
        // The mock answers on URLSession's loading thread while the wait polls on the main actor.
        let startedMessages = LockedValue<[String]>([])
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false,
                  "named_in_prompt": true
                }
                """, for: request)
            case "/api/chat/start":
                let body = try apiTestJSONBody(from: request)
                let message = try XCTUnwrap(body["message"] as? String)
                startedMessages.value.append(message)
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStartRun = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStartRun)
        XCTAssertNotNil(viewModel.activeStreamID)

        await viewModel.uploadAttachment(data: Data("hello".utf8), filename: "notes.txt")
        let result = await viewModel.submitStreamingMessage("", behavior: .steer)

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)

        streamClient.emit(.streamEnd)
        // The drain appends its optimistic row before its start request goes out, so wait for the request itself.
        try await waitUntil { startedMessages.value.count == 2 }

        XCTAssertEqual(startedMessages.value, ["Initial request", ""])
        XCTAssertTrue(viewModel.messages.contains { $0.attachments?.isEmpty == false })
    }
}
