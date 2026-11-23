import XCTest
@testable import TalariaKit

/// Transcript math formatting over a fixed corpus (TAL-859, TAL-2374).
///
/// Every message, streamed token by token, passes through the segmenter and the inline formatter. Prose with no `$`
/// or `\` holds no math opener, so it must come back without either pass building a character array or a code mask.
/// An opener with no closer searches the rest of its text once per pass, not once per stray opener
/// (`\(` once per line).
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

    /// 512 `\[` openers with no closer, then valid display math under `$$`.
    func testUnclosedBracketOpenersSearchForACloserOnce() {
        let stray = String(repeating: #"\[ a "#, count: 512)
        TranscriptProbeRecorder.reset()

        let segments = MarkdownMathSegmenter.segments(in: stray + "\n$$x^2$$")

        XCTAssertEqual(segments, [.markdown(stray + "\n"), .displayMath("x^2")])
        XCTAssertEqual(TranscriptProbeRecorder.counts["mathDisplayCloserSearch"], 2)
    }

    /// 512 `\(` openers with no closer on one line, then valid inline math on the next line and under `$`.
    func testUnclosedParenOpenersSearchForACloserOncePerLine() {
        let stray = String(repeating: #"\( a "#, count: 512)
        TranscriptProbeRecorder.reset()

        let formatted = approximatingInlineMath(stray + "$x^2$\n" + #"\(y^2\)"#)

        XCTAssertEqual(formatted, stray + "x²\ny²")
        XCTAssertEqual(TranscriptProbeRecorder.counts["mathInlineCloserSearch"], 3)
    }
}
