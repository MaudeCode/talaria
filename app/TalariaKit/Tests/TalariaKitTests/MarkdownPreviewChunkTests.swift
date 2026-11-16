import XCTest
@testable import TalariaKit

/// A long Markdown file preview drawn in lazy chunks (TAL-844).
@MainActor
final class MarkdownPreviewChunkTests: APIClientTestCase {
    /// Over 6,000 characters of one paragraph, so the next safe boundary seals a chunk.
    private static let longParagraph = String(repeating: "Line of prose. ", count: 420)

    func testFileUnderTheThresholdIsOneChunk() {
        let markdown = "# Notes\n\nShort file.\n\n```swift\nlet a = 1\n```\n"

        XCTAssertEqual(MarkdownPreviewChunk.chunks(for: markdown), [MarkdownPreviewChunk(id: 0, text: markdown, topSpacing: 0)])
    }

    func testFileOverThePlainFallbackStaysOneChunk() {
        let markdown = String(repeating: "Paragraph line.\n\n", count: 1_100)

        XCTAssertEqual(MarkdownPreviewChunk.chunks(for: markdown).count, 1)
    }

    /// Each seam restores the gap one document draws between the two blocks: the larger of the first's bottom margin
    /// and the second's top margin in the chat theme.
    func testSeamsRestoreTheSingleDocumentGap() {
        let cases: [(name: String, markdown: String, gap: CGFloat)] = [
            ("heading after paragraph", Self.longParagraph + "\n\n## Next\nBody.", 24),
            ("code block after paragraph", Self.longParagraph + "\n\n```swift\nlet a = 1\n```\n", 16),
            ("paragraph after code block", Self.longParagraph + "\n```swift\nlet a = 1\n```\nAfter the code.", 12),
            ("paragraph after thematic break", Self.longParagraph + "\n\n---\nAfter the break.", 24),
            ("paragraph after setext heading", Self.longParagraph + "\n---\nAfter the heading.", 16),
        ]
        for (name, markdown, gap) in cases {
            let chunks = MarkdownPreviewChunk.chunks(for: markdown)

            XCTAssertEqual(chunks.count, 2, name)
            XCTAssertEqual(chunks.map(\.topSpacing), [0, gap], name)
            XCTAssertEqual(chunks.map(\.text).joined(), markdown, name)
        }
    }

    /// A reference link resolves in whichever chunk it lands: every chunk carries the file's definitions.
    func testEveryChunkCarriesTheFileReferenceDefinitions() {
        let markdown = "See the [Documentation][docs].\n\n" + Self.longParagraph + "\n\n## Links\n\n[docs]: https://example.test/docs\n"
            + "[^note]: A footnote, not a link.\n"

        let chunks = MarkdownPreviewChunk.chunks(for: markdown)

        XCTAssertEqual(chunks.count, 2)
        XCTAssertTrue(chunks.allSatisfy { $0.text.contains("\n[docs]: https://example.test/docs") })
        XCTAssertEqual(chunks.filter { $0.text.contains("[^note]") }.count, 1)
    }

    /// A blank line between list items continues the list, so it never ends a chunk: split there, the second item
    /// would number from one again.
    func testLooseListIsNeverSplitBetweenItems() {
        let markdown = "1. " + Self.longParagraph + "\n\n1. Second item\n\n- Bullet one\n\n- Bullet two\n"

        let chunks = MarkdownPreviewChunk.chunks(for: markdown)

        XCTAssertEqual(chunks.count, 1)
    }

    func testMarkdownFileSplitsOncePerLoad() async throws {
        let markdown = (0..<12).map { "## Section \($0)\n\n" + Self.longParagraph + "\n\n```swift\nlet a = \($0)\n```\n" }
            .joined(separator: "\n")
        let body = try JSONSerialization.data(withJSONObject: ["path": "NOTES.md", "content": markdown])
        let client = makeClient { request in apiTestJSONResponse(String(decoding: body, as: UTF8.self), for: request) }
        let viewModel = try FilePreviewViewModel(
            session: makeFilePreviewSession(),
            server: XCTUnwrap(URL(string: "https://example.test")),
            path: "NOTES.md",
            apiClient: client
        )
        let recorder = ChatBodyEvaluationRecorder()
        ChatBodyEvaluationRecorder.installed = recorder
        defer { ChatBodyEvaluationRecorder.installed = nil }

        await viewModel.load()
        let firstRead = viewModel.markdownChunks
        let secondRead = viewModel.markdownChunks

        XCTAssertGreaterThan(firstRead.count, 1)
        XCTAssertEqual(firstRead, secondRead)
        XCTAssertEqual(firstRead.map(\.text).joined(), markdown)
        XCTAssertEqual(recorder.counts["markdownSplit"], 1)
    }
}
