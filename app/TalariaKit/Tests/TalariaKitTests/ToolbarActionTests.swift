import XCTest
@testable import TalariaKit

final class ToolbarActionTests: XCTestCase {
    func testEveryActionHasExactlyTheApprovedPriority() {
        let expected: [ToolbarAction: ToolbarAction.Priority] = [
            .chatGoal: .high, .chatFiles: .high, .chatCompanionPage: .high, .chatGit: .standard, .chatMore: .low,
            .chatBackgroundTasks: .high, .chatQueuedMessages: .high,
            .newChat: .highest, .search: .highest, .drawer: .high, .account: .high,
            .filters: .standard, .notifications: .highest,
            .selectChats: .low, .chatsRefresh: .low,
            .create: .high, .refresh: .standard, .secondary: .low,
            .commit: .high, .done: .high, .share: .low,
        ]
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: ToolbarAction.allCases.map { ($0, $0.priority) }), expected)
    }
}
