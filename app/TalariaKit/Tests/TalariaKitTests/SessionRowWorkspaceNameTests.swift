import XCTest
@testable import TalariaKit

/// The session row shows the server's workspace label, never one taken from the path (TAL-303).
final class SessionRowWorkspaceNameTests: XCTestCase {
    func testTheRowShowsTheServerWorkspaceNameNotTheFolderName() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let row = try decoder.decode(
            SessionSummary.self,
            from: Data(#"{"session_id": "named", "workspace": "/src/talaria-main", "workspace_name": "Talaria", "message_count": 2}"#.utf8)
        )

        XCTAssertEqual(
            SessionRowPresentation.metadataLabel(for: row, showsMessageCount: false, showsWorkspace: true),
            "Talaria"
        )
    }
}
