import XCTest
@testable import TalariaKit

final class ChatToolbarHeaderTests: XCTestCase {
    func testSubtitleUsesWorkspaceBasenameBeforeProfile() {
        XCTAssertEqual(
            ChatToolbarSubtitleResolver.subtitle(
                workspacePath: "/Users/example/talaria",
                profileTitle: "Default"
            ),
            "talaria"
        )
    }

    func testSubtitleFallsBackToStableProfileTitle() {
        XCTAssertEqual(
            ChatToolbarSubtitleResolver.subtitle(
                workspacePath: nil,
                profileTitle: "Work"
            ),
            "Work"
        )
    }

    func testSubtitleOmitsGenericOrBlankContext() {
        XCTAssertNil(ChatToolbarSubtitleResolver.subtitle(workspacePath: nil, profileTitle: "Profile"))
        XCTAssertNil(ChatToolbarSubtitleResolver.subtitle(workspacePath: "   ", profileTitle: "   "))
    }
}
