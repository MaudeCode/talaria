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

/// The launch check that decides whether an installed App update offers its What's New (TAL-182).
final class WhatsNewLaunchTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        let name = "WhatsNewLaunchTests.\(UUID())"
        defaults = UserDefaults(suiteName: name)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    }

    /// A stamped build of `version`: its own announcement unless `payload` overrides it, or none when `nil`.
    private func build(_ version: String, payload: String?? = .none, rows: Int = 2) -> [String: Any] {
        let source = String(repeating: "a", count: 40)
        var info: [String: Any] = ["CFBundleShortVersionString": version, "TalariaRelease": ["sourceRevision": source]]
        let announcement: [String: Any] = [
            "schemaVersion": 1, "id": "app-\(version)", "component": "app", "version": version, "sourceCommit": source,
            "rows": (1...rows).map { ["id": "TAL-\($0)-1", "icon": "chat", "title": "Row \($0) of \(version)", "description": "Synthetic."] },
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

    func testFirstInstallRecordsItsBaselineQuietly() {
        XCTAssertNil(launch(build("1.1.0")), "A fresh install introduces nothing")
        XCTAssertNil(launch(build("1.1.0")), "Relaunching the same version stays quiet")
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        XCTAssertNil(launch(build("1.1.0")), "The first-install release counts as seen")
    }

    func testMarketingUpgradeOffersOnceItIsAcknowledged() throws {
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        let offered = try XCTUnwrap(launch(build("1.1.0")))
        XCTAssertEqual(offered.id, "app-1.1.0")
        XCTAssertEqual(offered.rows.map(\.title), ["Row 1 of 1.1.0", "Row 2 of 1.1.0"])
        // Presented but never closed (the process ended): still offered on the next launch.
        XCTAssertEqual(launch(build("1.1.0"))?.id, "app-1.1.0")
        offered.acknowledge(defaults: defaults)
        XCTAssertNil(launch(build("1.1.0")), "An acknowledged release stays quiet on relaunch")
    }

    func testBuildOnlyChangeStaysQuiet() {
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        XCTAssertNil(launch(build("1.0.0")), "A new build of the same marketing version announces nothing")
    }

    func testMissingEmptyAndMalformedContentRecordsTheVersionQuietly() {
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        for (version, payload) in [("1.1.0", nil), ("1.2.0", "{"), ("1.3.0", "{\"rows\":[]}")] as [(String, String?)] {
            XCTAssertNil(launch(build(version, payload: .some(payload))), version)
            XCTAssertNil(launch(build(version)), "\(version) was recorded, so a later build of it stays quiet")
        }
    }

    func testAcknowledgedReleaseStaysQuietAfterADowngrade() throws {
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        try XCTUnwrap(launch(build("1.1.0"))).acknowledge(defaults: defaults)
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        XCTAssertNil(launch(build("1.1.0")), "Returning to an acknowledged release does not repeat it")
    }

    func testSkippedReleasesOfferOnlyTheInstalledOneThenTheNextUpdateOffersAgain() throws {
        XCTAssertNil(launch(build("1.0.0", payload: .some(nil))))
        let skipped = try XCTUnwrap(launch(build("1.4.0", rows: 4)))
        XCTAssertEqual(skipped.id, "app-1.4.0")
        XCTAssertEqual(skipped.rows.count, 4)
        XCTAssertTrue(skipped.rows.allSatisfy { $0.title.hasSuffix("1.4.0") })
        skipped.acknowledge(defaults: defaults)
        XCTAssertEqual(launch(build("1.5.0"))?.id, "app-1.5.0", "A second update offers its own release")
    }
}
