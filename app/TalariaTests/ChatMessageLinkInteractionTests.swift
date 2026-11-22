import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Proves the geometry end of the pipeline: a rendered mixed text-and-link
/// paragraph reports where its link was actually drawn.
@MainActor
final class ChatMarkdownLinkGeometryTests: XCTestCase {
    func testRenderedParagraphReportsItsLinkRect() throws {
        let store = try renderRegions(
            content: "FixturePlainLead words before [FixtureLinkTarget](https://example.invalid/fixture-link) and trailing words after."
        )
        let regions = store.regions()

        XCTAssertFalse(regions.isEmpty, "The rendered link reported no hit target")
        XCTAssertEqual(regions.first?.url, URL(string: "https://example.invalid/fixture-link"))
        for region in regions {
            XCTAssertGreaterThan(region.rect.width, 0)
            XCTAssertLessThan(region.rect.width, paragraphWidth)
            XCTAssertGreaterThan(region.rect.height, 0)
        }
    }

    /// Links live in table cells too, which render through their own block style.
    func testRenderedTableCellReportsItsLinkRect() throws {
        let store = try renderRegions(content: """
        | head | link |
        | --- | --- |
        | cell | [FixtureCellLink](https://example.invalid/cell) |
        """)

        XCTAssertEqual(
            store.regions().map(\.url),
            [URL(string: "https://example.invalid/cell")],
            "A link inside a table cell reported no hit target"
        )
    }

    /// Headings render through six block styles of their own (TAL-172). A press
    /// on the link opens the link actions; a press on the heading's lead text
    /// still opens the message actions.
    func testRenderedHeadingsReportTheirLinkRects() throws {
        for level in 1...6 {
            let url = try XCTUnwrap(URL(string: "https://example.invalid/heading-\(level)"))
            let store = try renderRegions(
                content: "\(String(repeating: "#", count: level)) Lead [Link](\(url.absoluteString))"
            )
            let regions = store.regions()

            XCTAssertEqual(regions.map(\.url), [url], "A link inside an h\(level) reported no hit target")
            let link = try XCTUnwrap(regions.first).rect
            XCTAssertGreaterThan(link.minX, 0, "h\(level) link rect starts at the heading's own origin")
            XCTAssertLessThan(link.maxX, paragraphWidth)
            XCTAssertGreaterThan(link.height, 0)

            XCTAssertEqual(
                ChatMessageMenuPolicy.target(at: CGPoint(x: link.midX, y: link.midY), linkRegions: regions),
                .link(url),
                "A press on the h\(level) link must open the link actions"
            )
            XCTAssertEqual(
                ChatMessageMenuPolicy.target(at: CGPoint(x: link.minX / 2, y: link.midY), linkRegions: regions),
                .message,
                "A press on the h\(level) lead text must open the message actions"
            )
        }
    }

    /// Tracking a heading must not change how it is drawn: the reference was
    /// recorded from MarkdownUI's own `gitHub` heading styles before `Theme.chat`
    /// restated them, so it pins sizes, weights, margins, line spacing, colors,
    /// and the h1/h2 dividers.
    func testTrackedHeadingsMatchTheBaseThemeRendering() throws {
        let content = (1...6).map { level in
            "\(String(repeating: "#", count: level)) Heading \(level) [link](https://example.invalid/\(level))\n\nBody text."
        }.joined(separator: "\n\n")

        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                ChatMarkdownView(content: content, colorScheme: scheme, isStreaming: false)
                    .environment(\.chatMessageLinkRegionStore, ChatMessageLinkRegionStore())
                    .padding(.horizontal, 16),
                named: "chat-markdown-headings-\(scheme == .dark ? "dark" : "light")",
                size: CGSize(width: 390, height: 760),
                colorScheme: scheme
            )
        }
    }

    /// The streaming fade is drawn by a text renderer of its own; tracking a
    /// link inside a streaming paragraph would replace it.
    func testStreamingParagraphReportsNoRegions() throws {
        let store = ChatMessageLinkRegionStore()
        try host(
            ChatMarkdownView(
                content: "words before [FixtureLinkTarget](https://example.invalid/x) and after.",
                colorScheme: .light,
                isStreaming: true
            )
            .environment(\.chatMessageLinkRegionStore, store)
        )

        XCTAssertEqual(store.regions(), [], "A streaming paragraph must leave its fade renderer in place")
    }

    /// TAL-2024: a paragraph past the inline limit draws as one `Text` and still reports its Markdown and bare links.
    func testParagraphPastTheInlineLimitReportsItsLinkRects() throws {
        let content = "Lead [FixtureLinkTarget](https://example.invalid/md) and https://example.invalid/bare then "
            + (0..<160).map { "`c\($0)`" }.joined(separator: " ")
        XCTAssertTrue(MarkdownContentRenderingPolicy.hasTooManyInlineElements(content))

        let regions = try renderRegions(content: content).regions()

        XCTAssertEqual(
            Set(regions.map(\.url)),
            [URL(string: "https://example.invalid/md"), URL(string: "https://example.invalid/bare")]
        )
    }

    func testParagraphWithoutLinksReportsNoRegions() throws {
        let store = try renderRegions(content: "FixturePlainLead words with no link at all in this paragraph.")
        XCTAssertEqual(store.regions(), [])
    }

    /// `MarkdownRenderer` also renders memory, skills, workspace previews and
    /// Kanban cards; inside a transcript row it reports its links.
    func testMarkdownRendererTracksLinksInsideATranscriptRow() throws {
        let content = "words before [FixtureLinkTarget](https://example.invalid/x) and after."
        let tracked = ChatMessageLinkRegionStore()
        try host(MarkdownRenderer(content: content).environment(\.chatMessageLinkRegionStore, tracked))
        XCTAssertEqual(tracked.regions().map(\.url), [URL(string: "https://example.invalid/x")])
    }

    private let paragraphWidth: CGFloat = 320

    /// Renders in a real window: the regions are published from the paragraph's
    /// draw pass, which only a hosted layout performs the way the transcript does.
    private func renderRegions(content: String) throws -> ChatMessageLinkRegionStore {
        let store = ChatMessageLinkRegionStore()
        try host(
            ChatMarkdownView(content: content, colorScheme: .light, isStreaming: false)
                .environment(\.chatMessageLinkRegionStore, store)
        )
        return store
    }

    /// Commits and draws the window once: the paragraphs publish their link regions from that draw pass.
    private func host(_ view: some View) throws {
        let window = try hostInOwnWindow(
            view.coordinateSpace(.named(ChatMessageInteraction.rowCoordinateSpace)),
            size: CGSize(width: paragraphWidth, height: 300)
        )
        commitDisplay(of: window)
    }
}

/// One paragraph with hundreds of inline elements, laid out and committed with an iPhone's 1 MB main-thread stack left
/// (TAL-2024). MarkdownUI joins a paragraph's inlines with `Text` `+`, which SwiftUI resolves recursively; the
/// simulator's 8 MB stack hides the overflow, so each render runs with only the phone's stack remaining.
@MainActor
final class ChatMarkdownInlineStackDepthTests: XCTestCase {
    func testInlineCodeHeavyParagraphRendersOnAPhoneStack() throws {
        try renderOnPhoneStack((0..<400).map { "`path/file\($0).swift`" }.joined(separator: " "))
    }

    func testBareURLParagraphRendersOnAPhoneStack() throws {
        try renderOnPhoneStack((0..<400).map { "https://example.invalid/p/\($0)" }.joined(separator: " "))
    }

    private func renderOnPhoneStack(_ markdown: String) throws {
        let window = try HostedScene.window(size: CGSize(width: 390, height: 900))
        addTeardownBlock { MainActor.assumeIsolated { window.isHidden = true; window.rootViewController = nil } }
        let thread = pthread_self()
        let bottom = Int(bitPattern: pthread_get_stackaddr_np(thread)) - pthread_get_stacksize_np(thread)
        withStack(left: 1_008 * 1024, above: bottom) {
            window.rootViewController = UIHostingController(
                rootView: ScrollView {
                    MarkdownRenderer(content: markdown)
                        .environment(\.chatMessageLinkRegionStore, ChatMessageLinkRegionStore())
                }
                .coordinateSpace(.named(ChatMessageInteraction.rowCoordinateSpace))
            )
            window.isHidden = false
            commitDisplay(of: window)
        }
    }
}

/// Recurses until about `limit` bytes of stack remain, then runs `body`.
@inline(never)
private func withStack(left limit: Int, above bottom: Int, _ body: () -> Void) {
    var marker = 0
    let sp = withUnsafeMutablePointer(to: &marker) { Int(bitPattern: $0) }
    if sp - bottom > limit { withStack(left: limit, above: bottom, body) } else { body() }
    withExtendedLifetime(marker) {}
}
