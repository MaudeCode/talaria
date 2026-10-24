import XCTest
@testable import TalariaKit

final class ToolbarActionTests: XCTestCase {
    func testEveryActionHasExactlyTheApprovedPriority() {
        let expected: [ToolbarAction: ToolbarAction.Priority] = [
            .chatGoal: .high, .chatFiles: .high, .chatGit: .standard,
            .chatBackgroundTasks: .high, .chatQueuedMessages: .high,
            .newChat: .high, .drawer: .high, .notifications: .standard,
            .selectChats: .low, .chatsRefresh: .low,
            .create: .high, .refresh: .standard, .secondary: .low,
            .commit: .high, .done: .high, .share: .low,
        ]
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: ToolbarAction.allCases.map { ($0, $0.priority(isVerticalBar: true)) }), expected)
    }

    func testHorizontalBarsKeepWorkBadgesHighAndOtherActionsStandard() {
        for action in ToolbarAction.allCases {
            let isWorkBadge = action == .chatBackgroundTasks || action == .chatQueuedMessages
            XCTAssertEqual(action.priority(isVerticalBar: false), isWorkBadge ? .high : .standard, "\(action)")
        }
    }
}
