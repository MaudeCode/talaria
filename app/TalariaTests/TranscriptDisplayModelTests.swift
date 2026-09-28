import XCTest
import AVFoundation
import ImageIO
import SwiftData
import SwiftUI
import UniformTypeIdentifiers
@testable import Talaria
@testable import TalariaKit

// The members of ReasoningBlockViewTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class ReasoningBlockViewTests: XCTestCase {
    @MainActor
    func testExpandedReasoningParsesMarkdownEmphasis() throws {
        let key = ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey
        let previousValue = UserDefaults.standard.object(forKey: key)
        UserDefaults.standard.set(true, forKey: key)
        defer {
            if let previousValue {
                UserDefaults.standard.set(previousValue, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }

        let plain = try renderedSize(of: "One two three four")
        let markdown = try renderedSize(of: "**One** **two** **three** **four**")

        XCTAssertGreaterThan(markdown.height, 44)
        XCTAssertLessThan(
            markdown.width - plain.width,
            24,
            "Markdown delimiters should not render as literal text."
        )
    }

    @MainActor
    private func renderedSize(of text: String) throws -> CGSize {
        let renderer = ImageRenderer(
            content: ReasoningBlockView(text: text)
                .fixedSize()
                .environment(\.colorScheme, .light)
        )
        return try XCTUnwrap(renderer.uiImage).size
    }
}
