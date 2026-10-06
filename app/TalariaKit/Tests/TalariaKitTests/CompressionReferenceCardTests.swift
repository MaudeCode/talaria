import XCTest
@testable import TalariaKit

/// The App places the server's `compression_reference` (TAL-560) and derives nothing else from it.
final class CompressionReferenceCardTests: XCTestCase {
    private let messages = [
        ChatMessage(role: "user", content: "Hello", timestamp: nil, messageId: "m0"),
        ChatMessage(role: "assistant", content: "Hi there", timestamp: nil, messageId: "m1"),
        ChatMessage(role: "user", content: "Next", timestamp: nil, messageId: "m2"),
    ]

    func testCardFollowsTheNamedRow() {
        XCTAssertEqual(card(afterMessageIndex: 1, offset: 0), CompressionReferenceCard(referenceText: "Summary.", afterRenderID: "transcript:1"))
    }

    func testCardFollowsTheNamedRowOfALaterWindow() {
        // The index is the full transcript's, so a window starting at row 10 holds row 11 at loaded index 1.
        XCTAssertEqual(card(afterMessageIndex: 11, offset: 10)?.afterRenderID, "transcript:11")
    }

    func testCardOfAHiddenRowFollowsThePrecedingRow() {
        let withTool = [messages[0], messages[1], ChatMessage(role: "tool", content: "ok", timestamp: nil, messageId: "t"), messages[2]]
        let card = ChatViewModel.compressionReferenceCard(
            reference: CompressionReference(text: "Summary.", afterMessageIndex: 2),
            messagesOffset: 0,
            transcriptMessages: ChatViewModel.transcriptMessages(from: withTool, messageOffset: 0)
        )
        XCTAssertEqual(card?.afterRenderID, "transcript:1")
    }

    func testCardSitsAboveTheTranscriptWithoutAnAnchorOrBeforeTheWindow() {
        XCTAssertEqual(card(afterMessageIndex: nil, offset: 0), CompressionReferenceCard(referenceText: "Summary.", afterRenderID: nil))
        XCTAssertNil(card(afterMessageIndex: 4, offset: 10)?.afterRenderID)
    }

    func testNoReferenceShowsNoCard() {
        XCTAssertNil(ChatViewModel.compressionReferenceCard(
            reference: nil,
            messagesOffset: 0,
            transcriptMessages: ChatViewModel.transcriptMessages(from: messages, messageOffset: 0)
        ))
    }

    private func card(afterMessageIndex: Int?, offset: Int) -> CompressionReferenceCard? {
        ChatViewModel.compressionReferenceCard(
            reference: CompressionReference(text: "Summary.", afterMessageIndex: afterMessageIndex),
            messagesOffset: offset,
            transcriptMessages: ChatViewModel.transcriptMessages(from: messages, messageOffset: offset)
        )
    }
}
