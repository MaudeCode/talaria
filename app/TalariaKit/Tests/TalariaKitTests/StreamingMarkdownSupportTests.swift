import XCTest
@testable import TalariaKit

final class StreamingMarkdownBlockSplitterTests: XCTestCase {
    func testShortTextStaysInActiveMarkdown() {
        let text = "Hello from Hermes."
        let segments = StreamingMarkdownBlockSplitter.split(text)

        XCTAssertTrue(segments.stableChunks.isEmpty)
        XCTAssertEqual(segments.activeMarkdown, text)
    }

    func testCompletedFenceSealsStableChunk() {
        let stableBody = String(repeating: "A", count: 6_100)
        let text = """
        \(stableBody)
        ```swift
        let answer = 42
        ```
        Still streaming
        """

        let segments = StreamingMarkdownBlockSplitter.split(text)

        XCTAssertEqual(segments.stableChunks.count, 1)
        XCTAssertTrue(segments.stableChunks[0].text.contains(stableBody))
        XCTAssertTrue(segments.activeMarkdown.contains("Still streaming"))
    }

    func testHeadingBoundaryCanSealWithoutFence() {
        let prose = String(repeating: "Line of prose.\n", count: 500)
        let text = prose + "## Next section\nMore text"

        let segments = StreamingMarkdownBlockSplitter.split(text)

        XCTAssertFalse(segments.stableChunks.isEmpty)
        XCTAssertTrue(segments.activeMarkdown.contains("More text"))
    }

    func testTabSeparatedHeadingCountsAsStableBoundary() {
        let prose = String(repeating: "Line of prose.\n", count: 500)
        let text = prose + "##\tTab heading\nMore text"

        let segments = StreamingMarkdownBlockSplitter.split(text)

        XCTAssertFalse(segments.stableChunks.isEmpty)
        XCTAssertTrue(segments.activeMarkdown.contains("More text"))
    }
}

/// Width resolution for chat markdown table cells (issue #233). The layout
/// itself needs a render pass to verify; this covers the pure clamp that
/// decides the wrap width the cell height is measured at.
final class TableCellWidthCapTests: XCTestCase {
    private let minWidth: CGFloat = 96
    private let maxWidth: CGFloat = 260

    func testIdealWidthBelowMinClampsToMin() {
        let width = TableCellWidthCap.resolvedWidth(
            idealWidth: 40, proposedWidth: nil, minWidth: minWidth, maxWidth: maxWidth
        )
        XCTAssertEqual(width, minWidth)
    }

    func testIdealWidthWithinBoundsIsUsedAsIs() {
        let width = TableCellWidthCap.resolvedWidth(
            idealWidth: 150, proposedWidth: nil, minWidth: minWidth, maxWidth: maxWidth
        )
        XCTAssertEqual(width, 150)
    }

    func testIdealWidthAboveMaxClampsToMax() {
        let width = TableCellWidthCap.resolvedWidth(
            idealWidth: 1_200, proposedWidth: nil, minWidth: minWidth, maxWidth: maxWidth
        )
        XCTAssertEqual(width, maxWidth)
    }

    func testProposedColumnWidthOverridesIdealWidth() {
        let width = TableCellWidthCap.resolvedWidth(
            idealWidth: 40, proposedWidth: 200, minWidth: minWidth, maxWidth: maxWidth
        )
        XCTAssertEqual(width, 200)
    }

    func testProposedColumnWidthIsStillClamped() {
        let width = TableCellWidthCap.resolvedWidth(
            idealWidth: 40, proposedWidth: 999, minWidth: minWidth, maxWidth: maxWidth
        )
        XCTAssertEqual(width, maxWidth)
    }
}

/// A streaming reply's open fence is split out exactly as the Markdown renderer would draw it (TAL-1396).
final class StreamingOpenCodeFenceTests: XCTestCase {
    private typealias Fence = StreamingOpenCodeFence

    func testSplitsTheFenceAReplyEndsInside() {
        XCTAssertEqual(Fence.trailing(in: "Intro\n\n```swift\nlet a\nlet b"),
                       Fence(leadingMarkdown: "Intro\n\n", language: "swift", code: "let a\nlet b"))
        // The renderer drops only the last newline of a code block's content.
        XCTAssertEqual(Fence.trailing(in: "```swift\nlet a\n\n")?.code, "let a\n")
        XCTAssertEqual(Fence.trailing(in: "Text\n```sw"), Fence(leadingMarkdown: "Text\n", language: "sw", code: ""))
        XCTAssertEqual(Fence.trailing(in: "```\na\n```\n\n~~~ \nb"),
                       Fence(leadingMarkdown: "```\na\n```\n\n", language: nil, code: "b"))
        // Only a run of the opening marker at least as long closes the fence.
        XCTAssertEqual(Fence.trailing(in: "````\ncode\n```\n~~~~\nmore")?.code, "code\n```\n~~~~\nmore")
    }

    func testLeavesEverythingElseToTheRenderer() {
        for markdown in [
            "Plain prose",
            "```swift\nlet a\n```\nAfter",
            "```swift\nlet a\n   ```  ",
            // An indented fence may belong to a list item.
            "- item\n\n  ```swift\nlet a",
            // A backtick fence's info string cannot hold a backtick, so this is inline code.
            "```a`b\nx",
            // An HTML block runs to the next blank line and swallows the fence.
            "<div>\n```swift\nlet a",
        ] {
            XCTAssertNil(Fence.trailing(in: markdown), markdown)
        }
    }
}
