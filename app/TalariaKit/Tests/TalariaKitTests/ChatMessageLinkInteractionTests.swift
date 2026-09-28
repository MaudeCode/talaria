import SwiftUI
import XCTest
@testable import TalariaKit

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
