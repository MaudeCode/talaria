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
    func testChunkedDocumentMatchesTheWholeDocumentHeight() throws {
        let documents = [
            Self.paragraph + "\n\n## Next\n\nBody.\n",
            Self.paragraph + "\n\n```swift\nlet a = 1\n```\n",
            Self.paragraph + "\n```swift\nlet a = 1\n```\nAfter the code.\n",
        ]
        for markdown in documents {
            let chunks = MarkdownPreviewChunk.chunks(for: markdown)
            XCTAssertEqual(chunks.count, 2)

            let whole = try height(of: [MarkdownPreviewChunk(id: 0, text: markdown, topSpacing: 0)])
            XCTAssertEqual(try height(of: chunks), whole, accuracy: 0.5, String(markdown.suffix(30)))
        }
    }

    private func height(of chunks: [MarkdownPreviewChunk]) throws -> CGFloat {
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
        // MarkdownUI applies block margins a pass after it reads them.
        for _ in 0..<5 {
            window.layoutIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return controller.view.intrinsicContentSize.height
    }
}
