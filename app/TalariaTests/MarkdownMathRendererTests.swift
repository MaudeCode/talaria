import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of MarkdownMathRendererTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class MarkdownMathRendererTests: XCTestCase {
    @MainActor
    func testMarkdownCodeHighlighterRendersLightModeSwiftForegroundColors() {
        let result = MarkdownCodeHighlighter.highlightedCode(
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
    func testMarkdownCodeHighlighterRendersLightModeNonSwiftForegroundColors() {
        let result = MarkdownCodeHighlighter.highlightedCode(
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

    func testMarkdownAttributedCodeFormatterPreservesForegroundColors() {
        let attributedCode = NSMutableAttributedString(
            string: "let value = true",
            attributes: [
                .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                .foregroundColor: UIColor.label
            ]
        )
        attributedCode.addAttributes(
            [
                .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .semibold),
                .foregroundColor: UIColor.systemPink
            ],
            range: NSRange(location: 0, length: 3)
        )
        attributedCode.addAttribute(
            .foregroundColor,
            value: UIColor.systemBlue,
            range: NSRange(location: 12, length: 4)
        )

        let segments = MarkdownAttributedCodeFormatter.lines(in: attributedCode)
            .flatMap(\.segments)

        XCTAssertEqual(segments.map(\.attributedText.string), ["let value = true"])
        XCTAssertGreaterThan(
            foregroundColorSignatures(in: segments[0].attributedText, userInterfaceStyle: .light).count,
            1
        )

        let firstFont = segments[0].attributedText.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        XCTAssertTrue(firstFont?.fontDescriptor.symbolicTraits.contains(.traitBold) ?? false)
        XCTAssertEqual(
            colorSignature(in: segments[0].attributedText, at: 0, userInterfaceStyle: .light),
            colorSignature(for: .systemPink, userInterfaceStyle: .light)
        )
        XCTAssertEqual(
            colorSignature(in: segments[0].attributedText, at: 12, userInterfaceStyle: .light),
            colorSignature(for: .systemBlue, userInterfaceStyle: .light)
        )
    }

    func testGroupedAssignmentSegmentationMatchesAcrossStreamingAndSettledPaths() {
        let content = "Streaming $E=[4,-2]$ and settled $p=(3,4)$ agree."

        XCTAssertEqual(
            MarkdownMathLayoutCache.uncachedLayout(for: content),
            MarkdownMathLayoutCache.layout(for: content)
        )
        XCTAssertEqual(
            MarkdownMathLayoutCache.uncachedLayout(for: content),
            .plain(MarkdownMathFormatter.replacingInlineMath(in: content))
        )
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

private func colorSignature(in attributedString: NSAttributedString, at location: Int, userInterfaceStyle: UIUserInterfaceStyle) -> String? {
    colorSignature(
        for: attributedString.attribute(.foregroundColor, at: location, effectiveRange: nil) as? UIColor,
        userInterfaceStyle: userInterfaceStyle
    )
}
