import XCTest
@testable import TalariaKit

/// TAL-1484: the unread position names a server transcript row by its `message_id`, else its `id`, else
/// `<absolute index>-<role>`; the transcript finds the row showing it by that key.
final class TranscriptRowKeyTests: XCTestCase {
    func testRowsAreFoundByEveryServerRowKey() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: Data(#"""
        [{"role":"user","content":"By id","id":41},
         {"role":"assistant","content":"By index"},
         {"role":"user","content":"By message id","message_id":"m","id":7}]
        """#.utf8))
        let rows = ChatViewModel.transcriptMessages(from: messages, messageOffset: 20)
        func shown(_ key: String) -> String? { rows.first { $0.shows(rowKey: key) }?.message.content }
        XCTAssertEqual(shown("41"), "By id")
        XCTAssertEqual(shown("21-assistant"), "By index")
        XCTAssertEqual(shown("m"), "By message id")
        XCTAssertNil(shown("7"), "A row with a message_id is named by it, not by its id")
    }
}
