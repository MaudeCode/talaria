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

/// The launch check that decides which packaged rows an App build offers (TAL-182, TAL-1980): each row once,
/// whatever build or marketing version carries it.
final class WhatsNewLaunchTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        let name = "WhatsNewLaunchTests.\(UUID())"
        defaults = UserDefaults(suiteName: name)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    }

    /// A stamped build of `version` packaging one row per ticket in `tickets`, or `payload` verbatim when given.
    private func build(_ version: String, tickets: [Int] = [1, 2], payload: String?? = .none) -> [String: Any] {
        let source = String(repeating: "a", count: 40)
        var info: [String: Any] = ["CFBundleShortVersionString": version, "TalariaRelease": ["sourceRevision": source]]
        let announcement: [String: Any] = [
            "schemaVersion": 1, "id": "app-\(version)", "component": "app", "version": version, "sourceCommit": source,
            "rows": tickets.map { ["id": "TAL-\($0)-1", "icon": "chat", "title": "Row \($0)", "description": "Synthetic."] },
        ]
        switch payload {
        case .none: info["TalariaWhatsNew"] = String(decoding: try! JSONSerialization.data(withJSONObject: announcement), as: UTF8.self)
        case let .some(text): info["TalariaWhatsNew"] = text
        }
        return info
    }

    private func launch(_ info: [String: Any]) -> WhatsNewAnnouncement? {
        WhatsNewAnnouncement.pending(info: info, defaults: defaults)
    }

    /// The persisted row acknowledgements, under the key every installed build reads.
    private var acknowledged: [String]? {
        defaults.stringArray(forKey: "whatsNew.acknowledgedRowIDs")
    }

    func testFirstRunRecordsEveryPackagedRowQuietly() {
        XCTAssertNil(launch(build("1.1.0")), "A fresh install introduces nothing")
        XCTAssertEqual(acknowledged, ["TAL-1-1", "TAL-2-1"])
        XCTAssertNil(launch(build("1.1.0")), "Relaunching the same build stays quiet")
    }

    func testALaterBuildOfTheSameVersionOffersOnlyItsNewRowUntilAcknowledged() throws {
        XCTAssertNil(launch(build("1.1.0", tickets: [1])))
        let offered = try XCTUnwrap(launch(build("1.1.0", tickets: [1, 2])), "A Nightly that packages a new row offers it")
        XCTAssertEqual(offered.rows.map(\.id), ["TAL-2-1"])
        // Presented but never closed (the process ended): still offered on the next launch.
        XCTAssertEqual(launch(build("1.1.0", tickets: [1, 2]))?.rows.map(\.id), ["TAL-2-1"])
        offered.acknowledge(defaults: defaults)
        XCTAssertEqual(acknowledged, ["TAL-1-1", "TAL-2-1"])
        XCTAssertNil(launch(build("1.1.0", tickets: [1, 2])), "Every packaged row is acknowledged")
    }

    func testAnUpdateOffersOnlyTheRowsNotYetAcknowledged() throws {
        XCTAssertNil(launch(build("1.0.0", tickets: [1])))
        let offered = try XCTUnwrap(launch(build("1.4.0", tickets: [1, 2])))
        XCTAssertEqual(offered.rows.map(\.id), ["TAL-2-1"])
        XCTAssertEqual(offered.rows.first?.title, "Row 2")
    }

    func testAnExistingInstallOffersEveryPackagedRow() throws {
        // An install from before row acknowledgement recorded only the marketing version it last saw.
        defaults.set("1.1.0", forKey: "whatsNew.lastVersion")
        let offered = try XCTUnwrap(launch(build("1.1.0", tickets: [1, 2, 3])))
        XCTAssertEqual(offered.rows.map(\.id), ["TAL-1-1", "TAL-2-1", "TAL-3-1"])
        offered.acknowledge(defaults: defaults)
        XCTAssertEqual(acknowledged, ["TAL-1-1", "TAL-2-1", "TAL-3-1"])
    }

    func testMissingOrMalformedContentStaysQuietWithoutHidingLaterRows() throws {
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))), "A first run without content is quiet")
        for payload in [nil, "{", "{\"rows\":[]}"] as [String?] {
            XCTAssertNil(launch(build("1.1.0", payload: .some(payload))), "\(String(describing: payload))")
        }
        XCTAssertEqual(launch(build("1.1.0"))?.rows.map(\.id), ["TAL-1-1", "TAL-2-1"])
    }
}
