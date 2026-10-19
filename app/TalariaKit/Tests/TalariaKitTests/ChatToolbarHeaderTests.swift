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

    func testADiagnosticChatLeadsWithItsServerMode() {
        XCTAssertEqual(ChatToolbarSubtitleResolver.subtitle(workspaceName: "Talaria", profileTitle: "Default", executionMode: .safe), "Safe Mode · Talaria")
        XCTAssertEqual(ChatToolbarSubtitleResolver.subtitle(workspaceName: nil, profileTitle: "Profile", executionMode: .ignoreConfig), "Ignore Profile Config")
        XCTAssertEqual(ChatToolbarSubtitleResolver.subtitle(workspaceName: "Talaria", profileTitle: nil, executionMode: .normal), "Talaria", "A normal chat shows no mode")
    }
}
