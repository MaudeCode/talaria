import XCTest
@testable import TalariaKit

final class ChatToolbarHeaderTests: XCTestCase {
    func testMissingProfileInGermanOmitsPlaceSubtitle() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"chat","workspace_name":"Old workspace label","place_label":null}"#.utf8))
        let germanPlaceholder = String(localized: "Profile", defaultValue: "Profil", locale: Locale(identifier: "de"))
        let subtitle = ChatToolbarSubtitleResolver.subtitle(placeLabel: session.placeLabel)
        XCTAssertNil(subtitle, "The header must omit \(germanPlaceholder) when the server sends null")
    }

    func testADiagnosticChatLeadsWithItsServerMode() {
        XCTAssertEqual(ChatToolbarSubtitleResolver.subtitle(placeLabel: "Talaria", executionMode: .safe), "Safe Mode · Talaria")
        XCTAssertEqual(ChatToolbarSubtitleResolver.subtitle(placeLabel: nil, executionMode: .ignoreConfig), "Ignore Profile Config")
        XCTAssertEqual(ChatToolbarSubtitleResolver.subtitle(placeLabel: "Talaria", executionMode: .normal), "Talaria")
    }
}
