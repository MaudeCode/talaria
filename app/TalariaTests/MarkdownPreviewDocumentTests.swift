import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// A Markdown file preview drawn in chunks lays out exactly as the same file drawn whole (TAL-844).
@MainActor
final class MarkdownPreviewDocumentTests: XCTestCase {
    private static let paragraph = String(repeating: "Line of prose. ", count: 420)

    /// Each seam's spacing stands in for the gap one document draws: a heading after a paragraph, a code block after a
    /// paragraph, and a paragraph after a code block.
    func testChunkedDocumentMatchesTheWholeDocumentHeight() async throws {
        let documents = [
            Self.paragraph + "\n\n## Next\n\nBody.\n",
            Self.paragraph + "\n\n```swift\nlet a = 1\n```\n",
            Self.paragraph + "\n```swift\nlet a = 1\n```\nAfter the code.\n",
        ]
        for markdown in documents {
            let chunks = MarkdownPreviewChunk.chunks(for: markdown)
            XCTAssertEqual(chunks.count, 2)

            let whole = try await height(of: [MarkdownPreviewChunk(id: 0, text: markdown, topSpacing: 0)])
            let chunked = try await height(of: chunks)
            XCTAssertEqual(chunked, whole, accuracy: 0.5, String(markdown.suffix(30)))
        }
    }

    private func height(of chunks: [MarkdownPreviewChunk]) async throws -> CGFloat {
        let controller = UIHostingController(rootView: MarkdownPreviewDocument(chunks: chunks) { EmptyView() }
            .frame(width: 358))
        controller.sizingOptions = .intrinsicContentSize
        let window = try HostedScene.window(size: HostedSize.phone)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        // MarkdownUI applies block margins a pass after it reads them; wait until the height stops changing.
        let settled = await awaitRenderedQuiet(in: window) { controller.view.intrinsicContentSize.height }
        XCTAssertTrue(settled, "The preview kept changing height")
        return controller.view.intrinsicContentSize.height
    }
}
