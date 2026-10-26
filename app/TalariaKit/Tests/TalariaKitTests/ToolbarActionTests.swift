import XCTest
@testable import TalariaKit

final class ToolbarActionTests: XCTestCase {
    func testEveryActionHasExactlyTheApprovedPriority() {
        let expected: [ToolbarAction: ToolbarAction.Priority] = [
            .chatGoal: .high, .chatFiles: .high, .chatGit: .standard,
            .newChat: .highest, .search: .highest, .drawer: .high, .account: .high,
            .filters: .standard, .notifications: .high,
            .selectChats: .low, .chatsRefresh: .low,
            .create: .high, .refresh: .standard, .secondary: .low,
            .commit: .high, .done: .high, .share: .low,
        ]
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: ToolbarAction.allCases.map { ($0, $0.priority) }), expected)
    }
}
