import Foundation
import XCTest
@testable import TalariaKit

/// TAL-57: Settings > About > Acknowledgements must list every package the App resolves, at its pinned version,
/// and every bundled notice file, including Talaria's own license.
final class AcknowledgementsInventoryTests: XCTestCase {
    // app/TalariaKit/Tests/TalariaKitTests/<file> -> app
    private let app = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    private var notices: URL { app.appendingPathComponent("Talaria/Resources/ThirdPartyNotices") }

    func testInventoryListsEveryResolvedPackageAtItsPinnedVersion() throws {
        let acknowledgements = try Acknowledgement.load(from: notices)
        let resolvedURL = app.appendingPathComponent(
            "Talaria.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        )
        let resolved = try JSONDecoder().decode(PackageResolved.self, from: Data(contentsOf: resolvedURL))
        let pinned = Dictionary(uniqueKeysWithValues: resolved.pins.map { ($0.identity, $0.state.version) })
        let listed = Dictionary(
            acknowledgements.compactMap { entry in entry.package.map { ($0, entry.version) } },
            uniquingKeysWith: { first, _ in first }
        )

        for (identity, version) in pinned.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(listed[identity] ?? nil, version, "\(identity): Acknowledgements.json is out of date")
        }
        XCTAssertEqual(Set(listed.keys).subtracting(pinned.keys), [], "Acknowledgements.json lists unshipped packages")
    }

    func testEveryNoticeFileIsListedAndReadable() throws {
        let acknowledgements = try Acknowledgement.load(from: notices)
        XCTAssertEqual(Set(acknowledgements.map(\.name)).count, acknowledgements.count, "Duplicate component names")

        let referenced = Set(acknowledgements.flatMap(\.files))
        let bundled = Set(try FileManager.default.contentsOfDirectory(atPath: notices.path))
            .subtracting([Acknowledgement.manifestName])
        XCTAssertEqual(referenced.subtracting(bundled).sorted(), [], "Acknowledgements.json names missing files")
        XCTAssertEqual(bundled.subtracting(referenced).sorted(), [], "Notice files no component shows")

        for entry in acknowledgements {
            XCTAssertFalse(try entry.notice(in: notices).isEmpty, "\(entry.name) has an empty notice")
        }
    }

    func testTalariaLicenseMatchesTheRepositoryLicense() throws {
        let acknowledgements = try Acknowledgement.load(from: notices)
        let talaria = try XCTUnwrap(acknowledgements.first { $0.name == "Talaria" }, "Talaria's own license is missing")
        XCTAssertEqual(talaria.files, ["Talaria-LICENSE.txt"])
        XCTAssertEqual(
            try Data(contentsOf: notices.appendingPathComponent("Talaria-LICENSE.txt")),
            try Data(contentsOf: app.appendingPathComponent("../LICENSE")),
            "Talaria-LICENSE.txt must match the repository LICENSE"
        )
    }

    func testReflowJoinsWrappedLinesButKeepsBlocks() {
        let text = """
        MIT License

        Copyright (c) 2026 Kilian Tyler
        Copyright (c) 2025 Hermes Web UI
        Contributors
        Portions copyright (c) 1990 by Elsevier, Inc.

        Permission is hereby granted, free of charge,
          to any person obtaining a copy, provided that the above
        copyright notice appears.
        THE SOFTWARE IS PROVIDED "AS IS",
        WITHOUT WARRANTY.

        DEFINITIONS
        "Font Software" refers to
        the set of files.
        -----------
           1. Definitions. "License" shall mean
              the terms.
           (a) You must give
           * Redistributions must
             retain the notice.
        | Asset | Slug |
        | --- | --- |
        % This work may be distributed
        % under the LPPL.
        """
        XCTAssertEqual(Acknowledgement.reflow(text), """
        MIT License

        Copyright (c) 2026 Kilian Tyler
        Copyright (c) 2025 Hermes Web UI Contributors
        Portions copyright (c) 1990 by Elsevier, Inc.

        Permission is hereby granted, free of charge, to any person obtaining a copy, provided that the above \
        copyright notice appears. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY.

        DEFINITIONS
        "Font Software" refers to the set of files.
        -----------
        1. Definitions. "License" shall mean the terms.
        (a) You must give
        * Redistributions must retain the notice.
        | Asset | Slug |
        | --- | --- |
        % This work may be distributed
        % under the LPPL.
        """)
    }
}

private struct PackageResolved: Decodable {
    struct Pin: Decodable {
        struct State: Decodable { let version: String? }
        let identity: String
        let state: State
    }

    let pins: [Pin]
}
