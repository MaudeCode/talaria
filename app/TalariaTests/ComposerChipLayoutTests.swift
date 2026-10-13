import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-484: a composer control shows its full title or only its icon, never a title cut to an
/// ellipsis. A truncated title stretches to whatever width the row offers, while either complete
/// form keeps its own width, so below the full title the fitted width must not follow the offer.
/// Every strip control (TAL-629) wraps `ComposerChipContent` in a flexible frame that fills any
/// offer, so the collapse is pinned on the shared content itself.
@MainActor
final class ComposerChipLayoutTests: XCTestCase {
    private let title = "feature/a-branch-name-too-long-for-a-narrow-composer"

    func testControlShowsItsIconOnlyWhenTheTitleDoesNotFit() {
        assertShowsFullTitleOrIconOnly(
            ComposerChipContent(title: title, spacing: 5, font: AppFont.footnote()) {
                Image(systemName: "arrow.triangle.branch")
            } trailing: {
                Image(systemName: "chevron.down")
            }
        )
    }

    private func assertShowsFullTitleOrIconOnly(
        _ chip: some View,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let host = UIHostingController(rootView: chip)
        func fittedWidth(offered: CGFloat) -> CGFloat {
            host.sizeThatFits(in: CGSize(width: offered, height: 200)).width
        }
        let full = fittedWidth(offered: 10_000)
        let collapsed = fittedWidth(offered: 1)
        XCTAssertLessThan(collapsed, full - 100, "The narrowest chip must drop its title", file: file, line: line)

        let partialTitleOffers = stride(from: collapsed + 1, to: full - 1, by: 4).filter { offered in
            abs(fittedWidth(offered: offered) - collapsed) > 0.5
        }
        XCTAssertEqual(
            partialTitleOffers.map { Int($0) },
            [],
            "At these offered widths the chip showed part of its title instead of only its icon",
            file: file,
            line: line
        )
        XCTAssertEqual(fittedWidth(offered: full), full, accuracy: 0.5, "A chip that fits keeps its full title", file: file, line: line)
    }
}

@MainActor
final class ComposerToolsetsHostedTests: APIClientTestCase {
    func testOlderServerKeepsTheToolsetEditorAndProfileDefaultAction() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"error":"not found"}"#, statusCode: 404, for: request)
        }
        var restored = false
        let window = try hostWindow(ComposerToolsetsSheet(
            loadCatalog: { try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: nil) },
            onSave: { names in XCTAssertNil(names); restored = true }
        ))
        let editor = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "legacy-toolsets" }
        XCTAssertNotNil(editor, "An older server must retain editable session toolsets")
        let defaults = try await requireElement(in: window, label: "Use profile defaults")
        HostedAccessibility.activate(defaults)
        await drainMainActor()
        XCTAssertTrue(restored)
    }

    func testLegacyPickerPreservesSavedNames() async throws {
        var saved: [String]?
        let window = try hostWindow(ComposerToolsetsSheet(
            toolsets: SessionToolsets(names: ["file"]), loadCatalog: { nil },
            onSave: { saved = $0 }
        ))
        let editor = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "legacy-toolsets" }
        XCTAssertEqual(try XCTUnwrap(editor).accessibilityValue, "file")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Save"))
        await drainMainActor()
        XCTAssertEqual(saved, ["file"])
    }

    func testToolsetPicker() async throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let catalog = try decoder.decode(ToolsetsCatalog.self, from: Data(#"{"toolsets":[{"name":"file","available":true,"selected":true},{"name":"todo","available":false,"selected":false,"unavailable_reason":"disabled"}],"selected_toolsets":["file"],"using_defaults":true}"#.utf8))
        let window = try hostWindow(ComposerToolsetsSheet(loadCatalog: { catalog }, onSave: { _ in }))
        _ = await awaitElement(in: window) { $0.accessibilityLabel?.contains("todo") == true }
        _ = try await requireElement(in: window, label: "Session toolsets")
        let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        attachment.name = "toolsets-after"
        attachment.lifetime = .keepAlways
        add(attachment)
        let disabled = await awaitElement(in: window) { $0.accessibilityLabel?.contains("todo") == true }
        XCTAssertNotNil(disabled, "The catalog must show the operator-disabled toolset")
        XCTAssertTrue(try XCTUnwrap(disabled).accessibilityTraits.contains(.notEnabled))
    }
}
