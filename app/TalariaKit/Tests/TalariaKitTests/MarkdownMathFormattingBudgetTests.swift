import XCTest
@testable import TalariaKit

/// Transcript math formatting over a fixed corpus (TAL-859).
///
/// Every message, streamed token by token, passes through the segmenter and the inline formatter. Prose with no `$`
/// or `\` holds no math opener, so it must come back without either pass building a character array or a code mask.
final class MarkdownMathFormattingBudgetTests: XCTestCase {
    /// 120 paragraphs of Markdown prose with code spans, fences and links, and no `$` or `\`.
    private static let prose = (0..<120).map { index in
        """
        Paragraph \(index) explains the change in plain words. Run `swift test --filter Case\(index)` and read \
        [the notes](https://example.test/notes/\(index)) before you merge; the **result** should match step \(index % 7).

        \(index.isMultiple(of: 10) ? "```swift\nlet value\(index) = \(index) * 2\n```\n" : "")
        """
    }.joined(separator: "\n")

    func testProseWithoutMathOpenersBuildsNoArrayOrMask() {
        TranscriptProbeRecorder.reset()

        let layout = MarkdownMathLayoutCache.uncachedLayout(for: Self.prose)
        let inline = MarkdownMathFormatter.replacingInlineMath(in: Self.prose)

        XCTAssertEqual(layout, .plain(Self.prose))
        XCTAssertEqual(inline, Self.prose)
        XCTAssertEqual(TranscriptProbeRecorder.counts, [:])
    }
}
