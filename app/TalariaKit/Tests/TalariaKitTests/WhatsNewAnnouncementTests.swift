import XCTest
@testable import TalariaKit

final class WhatsNewAnnouncementTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/whats-new.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func json(_ value: Any) throws -> String {
        if let text = value as? String { return text }
        return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    /// The Info.plist of a stamped build carrying `payload`, as `scripts/stamp-release.py` writes it.
    private func info(_ payload: Any?, version: String = "1.1.0", source: String = "0123456789abcdef0123456789abcdef01234567") throws -> [String: Any] {
        var info: [String: Any] = ["CFBundleShortVersionString": version, "TalariaRelease": ["sourceRevision": source]]
        if let payload { info[WhatsNewAnnouncement.infoKey] = try json(payload) }
        return info
    }

    func testStampedPayloadDecodesItsOrderedRows() throws {
        let announcement = try XCTUnwrap(WhatsNewAnnouncement.installed(info: info(fixture()["app"])))
        XCTAssertEqual(announcement.id, "app-1.1.0")
        XCTAssertEqual(announcement.rows.map(\.id), ["TAL-9-1", "TAL-10-1", "TAL-11-1", "TAL-11-2"])
        XCTAssertEqual(announcement.rows.first, .init(id: "TAL-9-1", icon: "chat", title: "Pinned chats",
                                                       description: "Keep the conversations you use most at the top of the list."))
    }

    func testUnknownFieldsAndIconsDecodeTolerantly() throws {
        var payload = try XCTUnwrap(fixture()["app"] as? [String: Any])
        payload["futureField"] = ["nested": true]
        var rows = try XCTUnwrap(payload["rows"] as? [[String: Any]])
        rows[0]["icon"] = "future-icon"
        rows[0]["badge"] = "new"
        payload["rows"] = rows
        XCTAssertEqual(WhatsNewAnnouncement.installed(info: try info(payload))?.rows.first?.icon, "future-icon")
    }

    func testMissingMalformedAndMismatchedPayloadsAreQuiet() throws {
        let fixture = try fixture()
        XCTAssertNil(WhatsNewAnnouncement.installed(info: [:]))
        XCTAssertNil(WhatsNewAnnouncement.installed(info: try info(nil)))
        for invalid in try XCTUnwrap(fixture["invalid"] as? [Any]) {
            XCTAssertNil(WhatsNewAnnouncement.installed(info: try info(invalid)), "\(invalid)")
        }
        for malformed in ["", "{", "null", "[]"] {
            XCTAssertNil(WhatsNewAnnouncement.installed(info: try info(malformed)))
        }
        // The Web payload, another version, another source, or an unstamped build is not this App release's.
        XCTAssertNil(WhatsNewAnnouncement.installed(info: try info(fixture["web"])))
        XCTAssertNil(WhatsNewAnnouncement.installed(info: try info(fixture["app"], version: "1.2.0")))
        XCTAssertNil(WhatsNewAnnouncement.installed(info: try info(fixture["app"], source: String(repeating: "d", count: 40))))
        var unstamped = try info(fixture["app"])
        unstamped["TalariaRelease"] = nil
        XCTAssertNil(WhatsNewAnnouncement.installed(info: unstamped))
        var wrongType = try info(nil)
        wrongType[WhatsNewAnnouncement.infoKey] = fixture["app"]
        XCTAssertNil(WhatsNewAnnouncement.installed(info: wrongType))
    }
}
