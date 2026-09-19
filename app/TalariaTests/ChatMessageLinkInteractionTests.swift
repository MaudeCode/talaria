import SwiftUI
import UIKit
import XCTest
@testable import Talaria

/// Link long-press isolation (TAL-49): a press over a link must resolve to that
/// link, and a press anywhere else in the same message must resolve to the
/// message's own actions.
final class ChatMessageMenuPolicyTests: XCTestCase {
    private let link = ChatMessageLinkRegion(
        rect: CGRect(x: 40, y: 100, width: 90, height: 18),
        url: URL(string: "https://example.invalid/a")!
    )

    func testPressInsideALinkResolvesToThatLink() {
        XCTAssertEqual(
            ChatMessageMenuPolicy.target(at: CGPoint(x: 80, y: 109), linkRegions: [link]),
            .link(link.url)
        )
    }

    func testPressBesideALinkOnTheSameLineResolvesToTheMessage() {
        XCTAssertEqual(
            ChatMessageMenuPolicy.target(at: CGPoint(x: 200, y: 109), linkRegions: [link]),
            .message
        )
    }

    func testPressOnTheLineBelowALinkResolvesToTheMessage() {
        XCTAssertEqual(
            ChatMessageMenuPolicy.target(at: CGPoint(x: 80, y: 140), linkRegions: [link]),
            .message
        )
    }

    func testMessageWithoutLinksAlwaysResolvesToTheMessage() {
        XCTAssertEqual(
            ChatMessageMenuPolicy.target(at: CGPoint(x: 80, y: 109), linkRegions: []),
            .message
        )
    }

    func testWrappedLinkKeepsEveryLineFragmentAsItsOwnTarget() {
        let second = ChatMessageLinkRegion(
            rect: CGRect(x: 0, y: 122, width: 50, height: 18),
            url: link.url
        )
        XCTAssertEqual(
            ChatMessageMenuPolicy.target(at: CGPoint(x: 20, y: 130), linkRegions: [link, second]),
            .link(link.url)
        )
    }
}

final class MarkdownLinkRangesTests: XCTestCase {
    func testMarkdownLinkRangeCoversTheRenderedLinkText() {
        let ranges = MarkdownLinkRanges.ranges(
            markdown: "alpha bravo [charlie](https://example.invalid/c) delta\n",
            plainText: "alpha bravo charlie delta\n"
        )

        XCTAssertEqual(ranges.count, 1)
        XCTAssertEqual(ranges.first?.range, 12..<19)
        XCTAssertEqual(ranges.first?.url, URL(string: "https://example.invalid/c"))
    }

    func testBareURLIsLinkedTheWayTheRendererAutolinksIt() {
        let ranges = MarkdownLinkRanges.ranges(
            markdown: "see https://example.invalid/plain now\n",
            plainText: "see https://example.invalid/plain now\n"
        )

        XCTAssertEqual(ranges.count, 1)
        XCTAssertEqual(ranges.first?.range, 4..<33)
        XCTAssertEqual(ranges.first?.url, URL(string: "https://example.invalid/plain"))
    }

    func testProseThatMerelyLooksLikeAHostIsNotALink() {
        XCTAssertEqual(
            MarkdownLinkRanges.ranges(
                markdown: "read chapter 2.1 and section 3.4 today\n",
                plainText: "read chapter 2.1 and section 3.4 today\n"
            ),
            []
        )
    }

    func testSoftBreakInsideAParagraphKeepsTheLinkOffset() {
        let ranges = MarkdownLinkRanges.ranges(
            markdown: "alpha bravo\n[charlie](https://example.invalid/c) delta\n",
            plainText: "alpha bravo\ncharlie delta\n"
        )

        XCTAssertEqual(ranges.first?.range, 12..<19)
    }

    /// A paragraph the two parsers disagree about must yield nothing, so the
    /// press falls through to the message menu instead of a guessed link.
    func testDisagreementBetweenParsersReportsNoLinks() {
        XCTAssertEqual(
            MarkdownLinkRanges.ranges(
                markdown: "alpha [charlie](https://example.invalid/c) delta\n",
                plainText: "a completely different paragraph\n"
            ),
            []
        )
    }
}

final class ChatMessageLinkRegionStoreTests: XCTestCase {
    func testRegionsAreReportedInTheRowCoordinateSpace() {
        let store = ChatMessageLinkRegionStore()
        let url = URL(string: "https://example.invalid/a")!
        store.setOrigin(CGPoint(x: 12, y: 200), forParagraph: paragraph)
        store.setRegions(
            [ChatMessageLinkRegion(rect: CGRect(x: 40, y: 20, width: 90, height: 18), url: url)],
            forParagraph: paragraph
        )

        XCTAssertEqual(
            store.regions(),
            [ChatMessageLinkRegion(rect: CGRect(x: 52, y: 220, width: 90, height: 18), url: url)]
        )
    }

    func testRemovedParagraphStopsReportingItsLinks() {
        let store = ChatMessageLinkRegionStore()
        store.setRegions(
            [ChatMessageLinkRegion(rect: CGRect(x: 0, y: 0, width: 10, height: 10), url: URL(string: "https://example.invalid/a")!)],
            forParagraph: paragraph
        )
        store.removeParagraph(paragraph)

        XCTAssertEqual(store.regions(), [])
    }

    private let paragraph = UUID()
}

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

    func testParagraphWithoutLinksReportsNoRegions() throws {
        let store = try renderRegions(content: "FixturePlainLead words with no link at all in this paragraph.")
        XCTAssertEqual(store.regions(), [])
    }

    /// `MarkdownRenderer` also renders memory, skills, workspace previews and
    /// Kanban cards. Only a transcript row tracks links there — and only a
    /// transcript row trades inline selection for that tracking.
    func testMarkdownRendererTracksLinksOnlyForATranscriptRow() throws {
        let content = "words before [FixtureLinkTarget](https://example.invalid/x) and after."
        let tracked = ChatMessageLinkRegionStore()
        try host(MarkdownRenderer(content: content).environment(\.chatMessageLinkRegionStore, tracked))
        XCTAssertEqual(tracked.regions().map(\.url), [URL(string: "https://example.invalid/x")])

        let untracked = ChatMessageLinkRegionStore()
        try host(MarkdownRenderer(content: content))
        XCTAssertEqual(untracked.regions(), [], "A view outside a transcript row must not report regions")
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

    private func host(_ view: some View) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first { $0.isKeyWindow } ?? scene.windows.first)
        let root = try XCTUnwrap(window.rootViewController)

        let host = UIHostingController(rootView: AnyView(
            view
                .frame(width: paragraphWidth)
                .coordinateSpace(.named(ChatMessageInteraction.rowCoordinateSpace))
        ))
        root.addChild(host)
        host.view.frame = CGRect(x: 0, y: 0, width: paragraphWidth, height: 300)
        root.view.addSubview(host.view)
        host.didMove(toParent: root)
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        addTeardownBlock {
            MainActor.assumeIsolated {
                host.view.removeFromSuperview()
                host.removeFromParent()
            }
        }
    }
}
