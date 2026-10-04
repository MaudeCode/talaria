import XCTest
@testable import TalariaKit

final class ChatToolbarHeaderTests: XCTestCase {
    func testSubtitleUsesTheServerWorkspaceNameBeforeProfile() {
        XCTAssertEqual(
            ChatToolbarSubtitleResolver.subtitle(
                workspaceName: "Talaria",
                profileTitle: "Default"
            ),
            "Talaria"
        )
    }

    func testSubtitleFallsBackToStableProfileTitle() {
        XCTAssertEqual(
            ChatToolbarSubtitleResolver.subtitle(
                workspaceName: nil,
                profileTitle: "Work"
            ),
            "Work"
        )
    }

    func testSubtitleOmitsGenericOrBlankContext() {
        XCTAssertNil(ChatToolbarSubtitleResolver.subtitle(workspaceName: nil, profileTitle: "Profile"))
        XCTAssertNil(ChatToolbarSubtitleResolver.subtitle(workspaceName: "   ", profileTitle: "   "))
    }
}
