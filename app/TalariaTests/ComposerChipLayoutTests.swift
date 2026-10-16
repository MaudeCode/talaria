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
final class StatusChipGroupTests: XCTestCase {
    private final class Model: ObservableObject {
        @Published var count = 0
        @Published var queueCount = 2
        @Published var compression = false
        @Published var runVisible = true
        var appearances = 0
        var queueOpens = 0
    }

    private struct Entries: View {
        @ObservedObject var model: Model
        var body: some View {
            StatusChipGroup {
                if model.count > 0 && model.runVisible {
                    RunStatusChip(.init(kind: model.compression ? .compressing : .active,
                                        runStartedAt: Date(timeIntervalSince1970: 2_000_000_000)), agentName: "Fixture")
                        .layoutPriority(-1)
                        .onAppear { model.appearances += 1 }
                }
                if model.count > 2 {
                    StatusChip(label: "Goal", icon: .symbol("target"))
                }
                if model.count > 1 {
                    Button { model.queueOpens += 1 } label: {
                        StatusChip(label: "\(model.queueCount) queued", icon: .symbol("text.badge.plus"))
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: model.count)
            .padding(16)
        }
    }

    func testZeroOneTwoThreeAndQueueUpdatesKeepTheStatusAlive() throws {
        let model = Model()
        let window = try hostWindow(Entries(model: model), animationsEnabled: true)
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains("2 queued"))
        for count in [1, 2, 3, 1, 2, 3] {
            model.count = count
            settle(0.3)
            let status = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Fixture is working on the response"))
            XCTAssertFalse(status.accessibilityTraits.contains(.button))
            XCTAssertEqual(model.appearances, 1, "Changing the segment count remounted the ticking status")
            if count > 1 {
                let queue = try XCTUnwrap(HostedAccessibility.element(in: window, label: "2 queued"))
                XCTAssertEqual(status.accessibilityFrame.midY, queue.accessibilityFrame.midY, accuracy: 1)
                HostedAccessibility.activate(queue)
            }
            XCTAssertEqual(HostedAccessibility.labels(in: window).contains("Goal"), count > 2)
        }
        XCTAssertEqual(model.queueOpens, 4)
        model.count = 1
        settle(0.05)
        model.count = 3
        settle(0.3)
        XCTAssertEqual(model.appearances, 1, "Removal and re-add during animation remounted the status")
        model.queueCount = 12
        settle()
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "12 queued"))
        model.compression = true
        model.count = 2
        settle()
        let compression = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Fixture is compressing the context"))
        let queue = try XCTUnwrap(HostedAccessibility.element(in: window, label: "12 queued"))
        XCTAssertEqual(compression.accessibilityFrame.midY, queue.accessibilityFrame.midY, accuracy: 1)
        XCTAssertEqual(model.appearances, 1)
        model.runVisible = false
        settle(0.3)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Fixture is compressing the context"))
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "12 queued"), "Ending the run hid the queue")
        model.count = 0
        settle(0.3)
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains("12 queued"))
    }

    func testNarrowAndAccessibilityLayoutsPreserveIndependentControls() throws {
        for (width, typeSize) in [(CGFloat(150), DynamicTypeSize.large), (390, .accessibility5)] {
            let model = Model()
            model.count = 3
            let window = try hostWindow(Entries(model: model).environment(\.dynamicTypeSize, typeSize), size: CGSize(width: width, height: 844))
            let status = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Fixture is working on the response"))
            let queue = try XCTUnwrap(HostedAccessibility.element(in: window, label: "2 queued"))
            let goal = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Goal"))
            XCTAssertLessThan(status.accessibilityFrame.maxY, goal.accessibilityFrame.minY)
            XCTAssertLessThan(goal.accessibilityFrame.maxY, queue.accessibilityFrame.minY)
            XCTAssertGreaterThanOrEqual(queue.accessibilityFrame.height, 44)
            for element in [status, goal, queue] {
                XCTAssertTrue(window.bounds.contains(window.convert(element.accessibilityFrame, from: nil)))
            }
            HostedAccessibility.activate(queue)
            XCTAssertEqual(model.queueOpens, 1)
            let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            })
            attachment.name = width == 150 ? "segments-narrow" : "segments-accessibility"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testLightDarkAndRightToLeftKeepTheQueueSeparate() throws {
        for dark in [false, true] {
            let model = Model()
            model.count = 2
            let window = try hostWindow(Entries(model: model)
                .environment(\.layoutDirection, dark ? .rightToLeft : .leftToRight)) {
                    $0.userInterfaceStyle = dark ? .dark : .light
                }
            let status = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Fixture is working on the response"))
            let queue = try XCTUnwrap(HostedAccessibility.element(in: window, label: "2 queued"))
            XCTAssertEqual(status.accessibilityFrame.midY, queue.accessibilityFrame.midY, accuracy: 1)
            if dark {
                XCTAssertGreaterThan(status.accessibilityFrame.minX, queue.accessibilityFrame.maxX)
            } else {
                XCTAssertLessThan(status.accessibilityFrame.maxX, queue.accessibilityFrame.minX)
            }
            HostedAccessibility.activate(queue)
            XCTAssertEqual(model.queueOpens, 1)
            let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            })
            attachment.name = dark ? "segments-dark-rtl" : "segments-light"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
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
