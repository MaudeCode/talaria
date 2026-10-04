import AVFoundation
import Photos
import UniformTypeIdentifiers
import XCTest
@testable import TalariaKit

@MainActor
final class TranscriptMediaPreviewViewModelTests: XCTestCase {
    override func tearDown() {
        TranscriptMediaPreviewMockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testLoadLocalImageUsesMediaEndpointAndCachesOriginalData() async throws {
        let recorder = TranscriptMediaPreviewRequestRecorder()
        let imageData = try XCTUnwrap(Self.imageData())
        let mediaPath = "/Users/hermes/.hermes/browser_screenshots/example.png"
        let sessionID = "session-123"
        let client = makeClient { request in
            recorder.record(request)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/media")
            return self.response(statusCode: 200, data: imageData, for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: Self.serverMedia(mediaPath, kind: .image),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
        XCTAssertNotNil(viewModel.previewData)
        XCTAssertEqual(viewModel.originalByteCount, imageData.count)
        XCTAssertTrue(viewModel.canSaveImageToPhotos)
        XCTAssertTrue(viewModel.canSaveMediaToPhotos)
        XCTAssertTrue(viewModel.canExportMedia)

        let queryItems = queryItems(for: try XCTUnwrap(recorder.firstURL))
        XCTAssertEqual(queryItems["session_id"], sessionID)
        XCTAssertEqual(queryItems["path"], mediaPath)

        let originalData = try await viewModel.originalImageData()
        XCTAssertEqual(originalData, imageData)
        let payload = try await viewModel.exportPayload()
        XCTAssertEqual(payload.data, imageData)
        XCTAssertEqual(payload.filename, "example.png")
        XCTAssertEqual(payload.contentType, .png)
        XCTAssertTrue(payload.isImage)
        XCTAssertFalse(payload.isVideo)
        XCTAssertEqual(recorder.requestCount, 1)
    }

    func testServerMediaURLKeepsItsEncodedPathAndExportsUnderItsName() async throws {
        let recorder = TranscriptMediaPreviewRequestRecorder()
        let imageData = try XCTUnwrap(Self.imageData())
        let client = makeClient { request in
            recorder.record(request)
            return self.response(statusCode: 200, data: imageData, for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: Self.serverMedia("/tmp/final chart.png", kind: .image),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertNil(viewModel.errorMessage)
        let queryItems = queryItems(for: try XCTUnwrap(recorder.firstURL))
        XCTAssertEqual(queryItems["session_id"], "session-123")
        XCTAssertEqual(queryItems["path"], "/tmp/final chart.png")

        let payload = try await viewModel.exportPayload()
        XCTAssertEqual(payload.filename, "final chart.png")
        XCTAssertEqual(payload.data, imageData)
        XCTAssertEqual(recorder.requestCount, 1)
    }

    func testLoadSameServerRemoteImageUsesAuthenticatedSession() async throws {
        let recorder = TranscriptMediaPreviewRequestRecorder()
        let imageData = try XCTUnwrap(Self.imageData())
        let remoteURL = try XCTUnwrap(URL(string: "https://example.test/generated/media/image.png?variant=full"))

        let client = makeClient { request in
            recorder.record(request)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url, remoteURL)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "*/*")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Test-Session"), "authenticated")
            return self.response(statusCode: 200, data: imageData, for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: .init(url: remoteURL.absoluteString, name: "image.png", mediaKind: .image),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.previewData)
        XCTAssertEqual(viewModel.originalByteCount, imageData.count)
        XCTAssertTrue(viewModel.canExportMedia)
        XCTAssertEqual(recorder.requestCount, 1)
    }

    func testLoadExternalRemoteImageDoesNotSendServerSessionCookies() async throws {
        let recorder = TranscriptMediaPreviewRequestRecorder()
        let imageData = try XCTUnwrap(Self.imageData())
        let externalURL = try XCTUnwrap(URL(string: "https://cdn.example.test/output/image.png"))
        let cookieStorage = HTTPCookieStorage()
        let cookie = try XCTUnwrap(Self.serverSessionCookie(domain: ".example.test"))
        cookieStorage.setCookie(cookie)

        let client = makeClient(cookieStorage: cookieStorage) { request in
            recorder.record(request)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url, externalURL)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "*/*")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Test-Session"), "public")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            return self.response(statusCode: 200, data: imageData, for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: .init(url: externalURL.absoluteString, name: "image.png", mediaKind: .image),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.previewData)
        XCTAssertEqual(viewModel.originalByteCount, imageData.count)
        XCTAssertTrue(viewModel.canExportMedia)
        XCTAssertEqual(recorder.requestCount, 1)
    }

    func testUnsupportedMediaSetsUnavailableStateWithoutRequest() async {
        let recorder = TranscriptMediaPreviewRequestRecorder()
        let client = makeClient { request in
            recorder.record(request)
            return self.response(statusCode: 200, data: Data(), for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: Self.serverMedia("/tmp/vector.svg", kind: .unsupported),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertFalse(viewModel.isLoading)
        XCTAssertEqual(viewModel.errorMessage, "Preview is not available for this media type.")
        XCTAssertNil(viewModel.previewData)
        XCTAssertNil(viewModel.lastError)
        XCTAssertFalse(viewModel.canSaveImageToPhotos)
        XCTAssertFalse(viewModel.canSaveMediaToPhotos)
        XCTAssertFalse(viewModel.canExportMedia)
        XCTAssertEqual(recorder.requestCount, 0)
    }

    func testLoadLocalVideoUsesMediaEndpointAndCreatesPlayableFileURL() async throws {
        let recorder = TranscriptMediaPreviewRequestRecorder()
        let videoData = Data("video-bytes".utf8)
        let mediaPath = "/tmp/generated/movie.mp4"
        let sessionID = "session-123"
        let client = makeClient { request in
            recorder.record(request)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/media")
            return self.response(statusCode: 200, data: videoData, for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: Self.serverMedia(mediaPath, kind: .video),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
        XCTAssertNil(viewModel.previewData)
        let videoFileURL = try XCTUnwrap(viewModel.videoFileURL)
        XCTAssertEqual(videoFileURL.pathExtension, "mp4")
        XCTAssertTrue(FileManager.default.fileExists(atPath: videoFileURL.path))
        XCTAssertEqual(try Data(contentsOf: videoFileURL), videoData)
        XCTAssertEqual(viewModel.originalByteCount, videoData.count)
        XCTAssertFalse(viewModel.canSaveImageToPhotos)
        XCTAssertTrue(viewModel.canSaveVideoToPhotos)
        XCTAssertTrue(viewModel.canSaveMediaToPhotos)
        XCTAssertTrue(viewModel.canExportMedia)

        let payload = try await viewModel.exportPayload()
        XCTAssertEqual(payload.data, videoData)
        XCTAssertEqual(payload.filename, "movie.mp4")
        XCTAssertEqual(payload.contentType, .mpeg4Movie)
        XCTAssertFalse(payload.isImage)
        XCTAssertTrue(payload.isVideo)

        let queryItems = queryItems(for: try XCTUnwrap(recorder.firstURL))
        XCTAssertEqual(queryItems["session_id"], sessionID)
        XCTAssertEqual(queryItems["path"], mediaPath)
        XCTAssertEqual(recorder.requestCount, 1)

        viewModel.cleanupTemporaryFiles()
        XCTAssertFalse(FileManager.default.fileExists(atPath: videoFileURL.path))
        XCTAssertNil(viewModel.videoFileURL)
        XCTAssertFalse(viewModel.canSaveMediaToPhotos)
    }

    func testSaveVideoFileToPhotoLibraryIntegration() async throws {
        guard ProcessInfo.processInfo.environment["TALARIA_RUN_PHOTOS_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TALARIA_RUN_PHOTOS_INTEGRATION=1 to modify the simulator photo library.")
        }

        let suppliedPath = ProcessInfo.processInfo.environment["TALARIA_PHOTOS_TEST_VIDEO_PATH"]
        let fileURL: URL
        if let suppliedPath {
            fileURL = URL(fileURLWithPath: suppliedPath)
        } else {
            fileURL = try await Self.makeTestVideo()
        }
        defer {
            if suppliedPath == nil {
                try? FileManager.default.removeItem(at: fileURL)
            }
        }

        try await PhotoLibrarySaver.saveVideoFile(at: fileURL)
    }

    func testInvalidVideoIsRejectedByPhotoLibraryIntegration() async throws {
        guard ProcessInfo.processInfo.environment["TALARIA_RUN_PHOTOS_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TALARIA_RUN_PHOTOS_INTEGRATION=1 to modify the simulator photo library.")
        }

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("invalid-video-\(UUID().uuidString).mp4")
        try Data("not a movie".utf8).write(to: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        do {
            try await PhotoLibrarySaver.saveVideoFile(at: fileURL)
            XCTFail("PhotoKit accepted an invalid video")
        } catch {
            XCTAssertEqual((error as NSError).domain, PHPhotosErrorDomain)
            XCTAssertEqual((error as NSError).code, PHPhotosError.Code.invalidResource.rawValue)
        }
    }

    func testMediaEndpointErrorIsCaptured() async {
        let client = makeClient { request in
            self.response(statusCode: 403, data: Data("forbidden".utf8), for: request)
        }
        let viewModel = TranscriptMediaPreviewViewModel(
            server: Self.baseURL,
            reference: Self.serverMedia("/tmp/forbidden.png", kind: .image),
            apiClient: client
        )

        await viewModel.load()

        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.previewData)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertFalse(viewModel.canSaveImageToPhotos)
        XCTAssertFalse(viewModel.canSaveMediaToPhotos)
        XCTAssertFalse(viewModel.canExportMedia)
    }

    private static let baseURL = URL(string: "https://example.test")!

    /// A local file as the server sends it (TAL-186): a server-root-relative `/api/media` URL naming the session.
    private static func serverMedia(_ path: String, kind: TranscriptMediaKind) -> TranscriptMediaReference {
        var components = URLComponents()
        components.path = "./api/media"
        components.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "session_id", value: "session-123")]
        return TranscriptMediaReference(url: components.string!, name: URL(fileURLWithPath: path).lastPathComponent, mediaKind: kind)
    }

    private static func makeTestVideo() async throws -> URL {
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("valid-video-\(UUID().uuidString).mp4")
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 64,
                AVVideoHeightKey: 64,
            ]
        )
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: 64,
                kCVPixelBufferHeightKey as String: 64,
            ]
        )
        guard writer.canAdd(input) else {
            throw PhotoLibraryTestVideoError.cannotConfigureWriter
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? PhotoLibraryTestVideoError.cannotStartWriter
        }
        writer.startSession(atSourceTime: .zero)

        guard let pool = adaptor.pixelBufferPool else {
            throw PhotoLibraryTestVideoError.cannotCreatePixelBuffer
        }
        var pixelBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess,
              let pixelBuffer
        else {
            throw PhotoLibraryTestVideoError.cannotCreatePixelBuffer
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        if let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) {
            memset(baseAddress, 0x30, CVPixelBufferGetDataSize(pixelBuffer))
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        guard adaptor.append(pixelBuffer, withPresentationTime: .zero) else {
            throw writer.error ?? PhotoLibraryTestVideoError.cannotAppendFrame
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw writer.error ?? PhotoLibraryTestVideoError.cannotFinishWriter
        }
        return outputURL
    }

    private func makeClient(
        cookieStorage: HTTPCookieStorage = HTTPCookieStorage(),
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> APIClient {
        TranscriptMediaPreviewMockURLProtocol.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TranscriptMediaPreviewMockURLProtocol.self]
        configuration.httpCookieStorage = cookieStorage
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.httpAdditionalHeaders = ["X-Talaria-Test-Session": "authenticated"]
        let session = URLSession(configuration: configuration)

        let publicConfiguration = URLSessionConfiguration.ephemeral
        publicConfiguration.protocolClasses = [TranscriptMediaPreviewMockURLProtocol.self]
        publicConfiguration.httpCookieStorage = nil
        publicConfiguration.httpCookieAcceptPolicy = .never
        publicConfiguration.httpShouldSetCookies = false
        publicConfiguration.httpAdditionalHeaders = ["X-Talaria-Test-Session": "public"]
        let publicSession = URLSession(configuration: publicConfiguration)

        return APIClient(baseURL: Self.baseURL, session: session, publicMediaSession: publicSession)
    }

    private func response(
        statusCode: Int,
        data: Data,
        for request: URLRequest
    ) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: request.url ?? Self.baseURL,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: nil
            )!,
            data
        )
    }

    private func queryItems(for url: URL) -> [String: String] {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        return Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    private static func imageData() -> Data? {
        TestImages.pngData(width: 24, height: 24)
    }

    private static func serverSessionCookie(domain: String) -> HTTPCookie? {
        HTTPCookie(properties: [
            .domain: domain,
            .path: "/",
            .name: "hermes_session",
            .value: "secret",
            .secure: "TRUE"
        ])
    }
}

private enum PhotoLibraryTestVideoError: Error {
    case cannotConfigureWriter
    case cannotStartWriter
    case cannotCreatePixelBuffer
    case cannotAppendFrame
    case cannotFinishWriter
}

private final class TranscriptMediaPreviewRequestRecorder {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var firstURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return requests.first?.url
    }

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return requests.count
    }

    func record(_ request: URLRequest) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
    }
}

private final class TranscriptMediaPreviewMockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

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
            let (response, data) = try requestHandler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension Data {
    mutating func appendLittleEndian(_ value: UInt16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(contentsOf: buffer)
        }
    }

    mutating func appendLittleEndian(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(contentsOf: buffer)
        }
    }
}
