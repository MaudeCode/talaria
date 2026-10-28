import XCTest
@testable import TalariaKit

final class APIClientSessionDetailTests: APIClientTestCase {
    func testServerReasoningVisibilityAndOlderServerFallback() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/reasoning-display.json"))
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let fixtures = try decoder.decode([String: SessionDetail].self, from: data)
        XCTAssertEqual(fixtures["hidden"]?.showReasoning, false)
        XCTAssertEqual(fixtures["hidden"]?.messages?.first?.reasoning, "")
        let merged = ChatViewModel.mergingLoadedMessages(
            try XCTUnwrap(fixtures["hidden"]?.messages),
            withCachedLocalOptimisticMessages: try XCTUnwrap(fixtures["shown"]?.messages)
        )
        XCTAssertEqual(merged.first?.reasoning, "")
        XCTAssertEqual(merged.first?.reasoningTitles, [])
        XCTAssertEqual(fixtures["hidden"]?.messages?.first?.content, "Public answer")
        XCTAssertEqual(fixtures["shown"]?.showReasoning, true)
        XCTAssertEqual(fixtures["shown"]?.messages?.first?.reasoning, "Synthetic thought")
        XCTAssertNil(fixtures["legacy"]?.showReasoning)
        XCTAssertEqual(fixtures["legacy"]?.messages?.first?.reasoning, "Synthetic thought")
    }
}
