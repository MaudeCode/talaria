import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

final class ChatAttachmentPreviewViewModelTests: APIClientTestCase {
    @MainActor
    func testMissingSessionIDSurfacesErrorWithoutRequest() async {
        let viewModel = makeViewModel(
            sessionID: nil,
            attachment: MessageAttachment(name: "notes.txt", path: "/tmp/notes.txt")
        )

        await viewModel.load()

        XCTAssertNil(viewModel.preview)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertEqual(viewModel.errorMessage, "Session ID is missing.")
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testMissingPathReturnsUnavailableWithoutRequest() async {
        let viewModel = makeViewModel(
            attachment: MessageAttachment(name: "notes.txt")
        )

        await viewModel.load()

        guard case let .unavailable(message) = viewModel.preview else {
            return XCTFail("Expected unavailable preview.")
        }
        XCTAssertEqual(message, "This attachment does not have a server file path.")
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testBlankPathReturnsUnavailableWithoutRequest() async {
        let viewModel = makeViewModel(
            attachment: MessageAttachment(name: "notes.txt", path: "  \n ")
        )

        await viewModel.load()

        guard case .unavailable = viewModel.preview else {
            return XCTFail("Expected unavailable preview.")
        }
    }

    @MainActor
    func testMissingPathUsesLocalImageFallback() async {
        let localData = Data([0x01, 0x02, 0x03])
        let viewModel = makeViewModel(
            attachment: MessageAttachment(name: "photo.png", mime: "image/png", isImage: true),
            localData: localData
        )

        await viewModel.load()

        guard case let .image(file) = viewModel.preview else {
            return XCTFail("Expected local image preview.")
        }
        XCTAssertEqual(file.data, localData)
        XCTAssertEqual(file.originalByteCount, localData.count)
    }

    @MainActor
    func testRemoteImageLoadsRawBytesAndBuildsPreview() async throws {
        let imageData = try XCTUnwrap(Self.imageData())
        let viewModel = makeViewModel(
            attachment: MessageAttachment(
                name: "photo.png",
                path: "/tmp/photo.png",
                mime: "image/png",
                isImage: true
            )
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/file/raw")
            return try Self.response(data: imageData, contentType: "image/png", for: request)
        }

        await viewModel.load()

        guard case let .image(file) = viewModel.preview else {
            return XCTFail("Expected remote image preview.")
        }
        XCTAssertNotNil(UIImage(data: file.data))
        XCTAssertEqual(file.originalByteCount, imageData.count)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testRemoteImageDecodeFailureReturnsUnavailable() async {
        let viewModel = makeViewModel(
            attachment: MessageAttachment(
                name: "broken.png",
                path: "/tmp/broken.png",
                mime: "image/png",
                isImage: true
            )
        ) { request in
            try Self.response(data: Data("not an image".utf8), contentType: "image/png", for: request)
        }

        await viewModel.load()

        guard case let .unavailable(message) = viewModel.preview else {
            return XCTFail("Expected unavailable preview.")
        }
        XCTAssertEqual(message, "Could not decode this image.")
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testRemoteAudioLoadsRawBytesBeforeBinaryRejection() async {
        let audioData = Data([0x49, 0x44, 0x33, 0x04])
        let viewModel = makeViewModel(
            attachment: MessageAttachment(
                name: "recording.mp3",
                path: "/tmp/recording.mp3",
                mime: "audio/mpeg",
                isImage: false
            )
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/file/raw")
            return try Self.response(data: audioData, contentType: "audio/mpeg", for: request)
        }

        await viewModel.load()

        guard case let .audio(data) = viewModel.preview else {
            return XCTFail("Expected audio preview.")
        }
        XCTAssertEqual(data, audioData)
    }

    @MainActor
    func testUnsupportedBinaryReturnsUnavailableWithoutRequest() async {
        let viewModel = makeViewModel(
            attachment: MessageAttachment(
                name: "archive.zip",
                path: "/tmp/archive.zip",
                mime: "application/zip",
                isImage: false
            )
        )

        await viewModel.load()

        guard case let .unavailable(message) = viewModel.preview else {
            return XCTFail("Expected unavailable preview.")
        }
        XCTAssertEqual(message, "Preview is not available for this file type.")
    }

    @MainActor
    func testTextFileLoadsDecodedResponse() async {
        let viewModel = makeViewModel(
            attachment: MessageAttachment(
                name: "notes.txt",
                path: "/tmp/notes.txt",
                mime: "text/plain",
                isImage: false
            )
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/file")
            return apiTestJSONResponse(
                #"{"content":"hello\n","path":"/tmp/notes.txt","size":6,"lines":1}"#,
                for: request
            )
        }

        await viewModel.load()

        guard case let .text(file) = viewModel.preview else {
            return XCTFail("Expected text preview.")
        }
        XCTAssertEqual(file.content, "hello\n")
        XCTAssertEqual(file.path, "/tmp/notes.txt")
        XCTAssertEqual(file.size, 6)
        XCTAssertEqual(file.lines, 1)
    }

    @MainActor
    func testLifecycleReloadIsIgnoredButForcedUserRetryRecovers() async {
        var requestCount = 0
        let viewModel = makeViewModel(
            attachment: MessageAttachment(
                name: "notes.txt",
                path: "/tmp/notes.txt",
                mime: "text/plain",
                isImage: false
            )
        ) { request in
            requestCount += 1
            if requestCount == 1 {
                throw URLError(.timedOut)
            }
            return apiTestJSONResponse(#"{"content":"recovered"}"#, for: request)
        }

        await viewModel.load()

        XCTAssertEqual(requestCount, 1)
        XCTAssertNil(viewModel.preview)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)

        await viewModel.load()
        XCTAssertEqual(requestCount, 1)

        await viewModel.load(force: true)

        XCTAssertEqual(requestCount, 2)
        guard case let .text(file) = viewModel.preview else {
            return XCTFail("Expected recovered text preview.")
        }
        XCTAssertEqual(file.content, "recovered")
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    private func makeViewModel(
        sessionID: String? = "session-preview",
        attachment: MessageAttachment,
        localData: Data? = nil,
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data) = { request in
            XCTFail("Unexpected request: \(request.url?.absoluteString ?? "nil")")
            throw URLError(.badURL)
        }
    ) -> ChatAttachmentPreviewViewModel {
        ChatAttachmentPreviewViewModel(
            session: SessionSummary(sessionId: sessionID),
            server: URL(string: "https://example.test")!,
            item: ChatAttachmentPreviewItem(message: attachment, localData: localData),
            apiClient: makeClient(handler: handler)
        )
    }

    private static func response(
        data: Data,
        contentType: String,
        for request: URLRequest
    ) throws -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: try XCTUnwrap(request.url),
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": contentType]
        )
        return (try XCTUnwrap(response), data)
    }

    private static func imageData() -> Data? {
        UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }.pngData()
    }
}
