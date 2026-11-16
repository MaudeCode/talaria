import XCTest
@testable import TalariaKit

/// Transcript math formatting over a fixed corpus (TAL-859).
///
/// Every message, streamed token by token, passes through the segmenter and the inline formatter. Prose with no `$`
/// or `\` holds no math opener, so it must come back without either pass building a character array or a code mask;
/// the mixed corpus records what real math still costs.
final class MarkdownMathFormattingBudgetTests: XCTestCase {
    /// 120 paragraphs of Markdown prose with code spans, fences and links, and no `$` or `\`.
    private static let prose = (0..<120).map { index in
        """
        Paragraph \(index) explains the change in plain words. Run `swift test --filter Case\(index)` and read \
        [the notes](https://example.test/notes/\(index)) before you merge; the **result** should match step \(index % 7).

        \(index.isMultiple(of: 10) ? "```swift\nlet value\(index) = \(index) * 2\n```\n" : "")
        """
    }.joined(separator: "\n")

    /// The prose interleaved with inline and display math every third paragraph.
    private static let mixed = (0..<120).map { index in
        switch index % 3 {
        case 0:
            #"Inline $x_\#(index) = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$ and \(\alpha \leq \beta\) hold for step \#(index)."#
        case 1:
            "$$\n\\sum_{i=1}^{\(index)} i^2 \\to \\infty \\Rightarrow \\lim_{n \\to \\infty} f(n) \\approx \\pi\n$$"
        default:
            "Paragraph \(index) explains the change in plain words with `code` and [a link](https://example.test/\(index))."
        }
    }.joined(separator: "\n\n")

    func testProseWithoutMathOpenersBuildsNoArrayOrMask() {
        TranscriptProbeRecorder.reset()

        let layout = MarkdownMathLayoutCache.uncachedLayout(for: Self.prose)
        let inline = MarkdownMathFormatter.replacingInlineMath(in: Self.prose)

        XCTAssertEqual(layout, .plain(Self.prose))
        XCTAssertEqual(inline, Self.prose)
        XCTAssertEqual(TranscriptProbeRecorder.counts, [:])
    }

    func testProseLayoutBudget() {
        measure(metrics: [XCTClockMetric()], options: Self.options) {
            for _ in 0..<5 {
                _ = MarkdownMathLayoutCache.uncachedLayout(for: Self.prose)
            }
        }
    }

    func testMixedMathLayoutBudget() {
        measure(metrics: [XCTClockMetric()], options: Self.options) {
            for _ in 0..<5 {
                _ = MarkdownMathLayoutCache.uncachedLayout(for: Self.mixed)
            }
        }
    }

    private static var options: XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        return options
    }
}
