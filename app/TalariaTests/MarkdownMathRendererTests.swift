import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of MarkdownMathRendererTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class MarkdownMathRendererTests: XCTestCase {
    /// TAL-971: a streaming reply's 30 token appends draw its expression once; every later update reuses the image.
    @MainActor
    func testStreamingAppendsDrawAnExpressionOnce() async throws {
        InlineMathImages.removeAll()
        let latex = #"\Phi_{S}\Phi^*"#
        let reply = StreamingReply(content: "The field $\(latex)$ couples")
        let window = try hostWindow(StreamingReplyView(reply: reply))
        let drawn = await awaitCondition { InlineMathImages.drawCounts[latex] == 1 }
        XCTAssertTrue(drawn, "The expression was never drawn")
        let scene = try XCTUnwrap(window.windowScene)

        for token in 0..<30 {
            reply.content += " token\(token)"
            await awaitDisplayUpdates(2, in: scene)
        }

        let settled = await awaitCondition {
            HostedAccessibility.labels(in: window).contains { $0.contains("token29") }
        }
        XCTAssertTrue(settled, "The last token never rendered")
        XCTAssertEqual(InlineMathImages.drawCounts, [latex: 1])
    }

    /// TAL-971: a reply cannot keep the main actor drawing without bound. Each image stays under `maxPixels`, a
    /// paragraph stops drawing once its images reach `drawingBudget`, and it then asks for nothing more.
    @MainActor
    func testHeavyParagraphStopsDrawingAtItsBudget() async throws {
        InlineMathImages.removeAll()
        let expressions = (0..<40).map { "x_{\($0)}" + String(repeating: #"+\sum_{i}^{n}"#, count: 30) }
        let content = expressions.map { "$\($0)$" }.joined(separator: " ")
        let window = try hostWindow(MarkdownRenderer(content: content))
        let style = InlineMathImageStyle(colorScheme: .light, scale: window.traitCollection.displayScale)
        let drawings = { InlineMathImages.drawCounts.keys.compactMap { InlineMathImages.cached($0, style: style) } }

        let reached = await awaitCondition {
            drawings().reduce(0) { $0 + $1.cost } >= InlineMathParagraphText.drawingBudget
        }
        XCTAssertTrue(reached, "The paragraph drew \(InlineMathImages.drawCounts.count) expressions")

        XCTAssertLessThan(InlineMathImages.drawCounts.count, expressions.count)
        XCTAssertEqual(Set(InlineMathImages.drawCounts.values), [1])
        for drawing in drawings() {
            XCTAssertLessThanOrEqual(drawing.image.width * drawing.image.height, InlineMathImages.maxPixels)
        }
        guard case .plain(let markdown) = MarkdownMathLayoutCache.uncachedLayout(for: content) else {
            return XCTFail("Inline math must not segment")
        }
        let paragraph = ChatMarkdownInlineStyle.flatParagraph(markdown: markdown, plainText: markdown, colorScheme: .light)
        XCTAssertEqual(InlineMathParagraphText.compose(paragraph, style: style).missing, [], "The settled paragraph asks for more")
    }

    /// TAL-971: inline math draws as an image inside its line, in a paragraph, a list item and emphasis, read aloud as
    /// its LaTeX between the words around it.
    @MainActor
    func testInlineMathDrawsInsideItsLine() async throws {
        InlineMathImages.removeAll()
        let markdown = """
        Mass $M_S$ here.

        - Item with $\\Phi\\Phi^*$ inline

        **Bold $M_I = M_S^*$ text** and *after*.

        ### Heading $h_1$

        | Point |
        |---|
        | $(4,-2)$ |
        """
        let window = try hostWindow(MarkdownRenderer(content: markdown))

        // A heading and a table cell draw through MarkdownUI's image providers, and read the same way.
        let expected = [
            "Mass M_S here.", #"Item with \Phi\Phi^* inline"#, "Bold M_I = M_S^* text and after.", "Heading h_1", "(4,-2)",
        ]
        let drawn = await awaitCondition {
            let labels = HostedAccessibility.labels(in: window)
            return expected.allSatisfy(labels.contains)
        }
        XCTAssertTrue(drawn, "Lines read \(HostedAccessibility.labels(in: window))")
        XCTAssertEqual(Set(InlineMathImages.drawCounts.keys), ["M_S", #"\Phi\Phi^*"#, "M_I = M_S^*", "h_1", "(4,-2)"])
    }

    @MainActor
    func testMarkdownCodeHighlighterRendersLightModeSwiftForegroundColors() async {
        let result = await MarkdownCodeHighlighter.highlightedCode(
            for: MarkdownCodeHighlightRequest(
                code: "func greet(name: String) -> String {\n    return \"Hello\"\n}",
                language: "swift",
                colorScheme: .light,
                isStreaming: false
            )
        )

        guard case .highlighted(let highlightedCode) = result else {
            return XCTFail("Expected Splash to highlight Swift code.")
        }

        let colors = foregroundColorSignatures(in: highlightedCode, userInterfaceStyle: .light)
        XCTAssertGreaterThan(colors.count, 1)
    }

    @MainActor
    func testMarkdownCodeHighlighterRendersLightModeNonSwiftForegroundColors() async {
        let result = await MarkdownCodeHighlighter.highlightedCode(
            for: MarkdownCodeHighlightRequest(
                code: """
                {
                  "enabled": true,
                  "name": "test"
                }
                """,
                language: "json",
                colorScheme: .light,
                isStreaming: false
            )
        )

        guard case .highlighted(let highlightedCode) = result else {
            return XCTFail("Expected Highlightr to highlight JSON code.")
        }

        let colors = foregroundColorSignatures(in: highlightedCode, userInterfaceStyle: .light)
        XCTAssertGreaterThan(colors.count, 1)
    }
}

@MainActor
@Observable
private final class StreamingReply {
    var content: String
    init(content: String) { self.content = content }
}

private struct StreamingReplyView: View {
    let reply: StreamingReply

    var body: some View {
        MarkdownRenderer(content: reply.content, isStreaming: true)
    }
}

private func foregroundColorSignatures(in attributedString: NSAttributedString, userInterfaceStyle: UIUserInterfaceStyle) -> Set<String> {
    var colors: Set<String> = []
    attributedString.enumerateAttribute(
        .foregroundColor,
        in: NSRange(location: 0, length: attributedString.length)
    ) { value, _, _ in
        guard let color = value as? UIColor,
              let signature = colorSignature(for: color, userInterfaceStyle: userInterfaceStyle) else {
            return
        }

        colors.insert(signature)
    }
    return colors
}

private func colorSignature(for color: UIColor?, userInterfaceStyle: UIUserInterfaceStyle) -> String? {
    guard let color else { return nil }

    let resolvedColor = color.resolvedColor(
        with: UITraitCollection(userInterfaceStyle: userInterfaceStyle)
    )
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0

    if resolvedColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha) {
        return [red, green, blue, alpha]
            .map { String(format: "%.3f", Double($0)) }
            .joined(separator: ",")
    }

    var white: CGFloat = 0
    if resolvedColor.getWhite(&white, alpha: &alpha) {
        return [white, alpha]
            .map { String(format: "%.3f", Double($0)) }
            .joined(separator: ",")
    }

    return nil
}
