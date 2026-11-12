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

    func testNewChatComposerShowsAgentModeAtPhoneAndDuoWidths() async throws {
        let fixture = try FixtureApp([UITestFixtureURLProtocol.executionModesArgument], for: self)
        let model = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        await model.loadActiveProfile()
        await model.loadExecutionModes()
        // The compact keyboard state hides this strip by design; the gallery exercises its visible state.
        let variants = HostedVariant.gallery + [HostedVariant(name: "duo-outer-narrow", size: CGSize(width: 382, height: 580), style: .light, textSize: .large)]
        for mode in [ExecutionMode.normal, .safe] {
            model.selectNewChatExecutionMode(mode)
            try await renderHostedPage("agent-mode-\(mode.rawValue)-composer", variants: variants) {
                NavigationStack {
                    PendingNewChatView(isExplicit: false, server: UITestFixtureEnvironment.serverURL, viewModel: model, onAPIError: { XCTFail("\($0)") }, draftStore: fixture.environment.draftStore)
                }.environment(\.scenePhase, .active).modelContainer(fixture.cache)
            } prepare: { window in
                let loaded = await self.awaitCondition {
                    guard let value = HostedAccessibility.element(in: window, label: "Select model")?.accessibilityValue else { return false }
                    return value != "Model"
                }
                XCTAssertTrue(loaded, "Inspect the strip after its actual model title loads")
            } inspect: { window, _ in
                let control = try await self.requireElement(in: window, label: "Agent Mode")
                XCTAssertEqual(control.accessibilityValue, mode.title)
                XCTAssertTrue(window.bounds.contains(window.convert(control.accessibilityFrame, from: nil)))
            }
        }
    }

    func testModeMenusShareCheckedSelectionAndCreatedChatShowsFrozenMode() async throws {
        let fixture = try FixtureApp([UITestFixtureURLProtocol.executionModesArgument], for: self)
        let model = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        await model.loadActiveProfile()
        await model.loadExecutionModes()
        let window = try hostWindow(NavigationStack {
            PendingNewChatView(server: UITestFixtureEnvironment.serverURL, viewModel: model, onAPIError: { XCTFail("\($0)") }, draftStore: fixture.environment.draftStore)
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
        _ = try await requireElement(in: window, label: "Agent Mode")
        func menu() -> [UIAction] {
            HostedAccessibility.menuActions(in: NewChatModeMenu.make(modes: model.newChatExecutionModes,
                selected: model.selectedNewChatExecutionMode, onSelect: model.selectNewChatExecutionMode))
        }
        XCTAssertEqual(menu().filter { $0.state == .on }.map(\.title), ["Normal"])
        HostedAccessibility.activate(try XCTUnwrap(menu().first { $0.title == "Safe Mode" }))
        let selected = await awaitCondition { model.selectedNewChatExecutionMode == .safe }
        XCTAssertTrue(selected)
        let selectedControl = try await requireElement(in: window, label: "Agent Mode")
        XCTAssertEqual(selectedControl.accessibilityValue, "Safe Mode")
        XCTAssertEqual(menu().filter { $0.state == .on }.map(\.title), ["Safe Mode"])
        attachHostedScreenshot(window, name: "agent-mode-selected-safe")
        try await sendFromComposer("Safe mode fixture prompt", in: window)
        let created = await awaitCondition {
            HostedAccessibility.element(in: window, label: "Agent Mode") == nil
                && HostedAccessibility.labels(in: window).contains { $0.contains("Safe Mode") }
        }
        XCTAssertTrue(created, "Creation hides the editable mode and shows the server's frozen mode in the header")
        attachHostedScreenshot(window, name: "agent-mode-created-safe")
        let disabledMenu = NewChatModeMenu.make(
            modes: [.init(mode: .normal, available: true), .init(mode: .safe, available: false, reason: "gateway_stopped")],
            selected: .normal, onSelect: model.selectNewChatExecutionMode)
        let section = try XCTUnwrap(disabledMenu.children.first as? UIMenu)
        let disabled = section.children.compactMap { $0 as? UIAction }
        XCTAssertEqual(disabled.last?.subtitle, "Start the gateway first")
        XCTAssertTrue(try XCTUnwrap(disabled.last).attributes.contains(.disabled))
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
        @Published var syncing = false
        @Published var reservedHeight: CGFloat = 0
        var appearances = 0
        var queueOpens = 0
    }

    private struct Entries: View {
        @ObservedObject var model: Model
        var body: some View {
            let hasRun = model.count > 0 && model.runVisible
            StatusChipGroup(
                reservesFirstSegment: !hasRun || !model.syncing,
                onReservedHeightChange: { model.reservedHeight = $0 }
            ) {
                if hasRun {
                    RunStatusChip(.init(kind: model.syncing ? .syncing : (model.compression ? .compressing : .active),
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
            attachHostedScreenshot(window, name: width == 150 ? "segments-narrow" : "segments-accessibility")
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
            attachHostedScreenshot(window, name: dark ? "segments-dark-rtl" : "segments-light")
        }
    }

    func testSyncingDoesNotIncreaseReservedHeightInRowsOrStacks() throws {
        for (width, typeSize) in [(CGFloat(390), DynamicTypeSize.large), (150, .large), (390, .accessibility1)] {
            let model = Model()
            model.count = 2
            model.runVisible = false
            let window = try hostWindow(Entries(model: model).environment(\.dynamicTypeSize, typeSize),
                                        size: CGSize(width: width, height: 844))
            settle()
            let queueHeight = model.reservedHeight
            XCTAssertGreaterThanOrEqual(queueHeight, 44)
            model.syncing = true
            model.runVisible = true
            settle()
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
            XCTAssertEqual(model.reservedHeight, queueHeight, accuracy: 1, "Syncing must not add transcript space")
            model.runVisible = false
            settle()
            XCTAssertEqual(model.reservedHeight, queueHeight, accuracy: 1)
            model.count = 0
            settle()
            XCTAssertEqual(model.reservedHeight, 0, accuracy: 1)
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
            loadCatalog: { _ in try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: nil) },
            onSave: { names in XCTAssertNil(names); restored = true; return SessionToolsets(names: names) }
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
            toolsets: SessionToolsets(names: ["file"]), loadCatalog: { _ in nil },
            onSave: { saved = $0; return SessionToolsets(names: $0) }
        ))
        let editor = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "legacy-toolsets" }
        XCTAssertEqual(try XCTUnwrap(editor).accessibilityValue, "file")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        await drainMainActor()
        XCTAssertEqual(saved, ["file"])
    }

    func testLegacyReturnDoesNotReplaceANewerDraft() async throws {
        let submitted = expectation(description: "legacy selection submitted")
        var reply: CheckedContinuation<SessionToolsets, Never>?
        let window = try hostWindow(ComposerToolsetsSheet(toolsets: SessionToolsets(names: ["file"]), loadCatalog: { _ in nil }, onSave: { names in
            XCTAssertEqual(names, ["file"])
            submitted.fulfill()
            return await withCheckedContinuation { reply = $0 }
        }))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "legacy-toolsets" }
        let field = try XCTUnwrap(window.firstView(ofType: UITextField.self))
        field.becomeFirstResponder()
        field.sendActions(for: .editingDidEndOnExit)
        await fulfillment(of: [submitted], timeout: 5)
        field.becomeFirstResponder()
        field.selectAll(nil)
        field.insertText("web")
        settle()
        attachHostedScreenshot(window, name: "legacy-newer-draft-before-reply")
        reply?.resume(returning: SessionToolsets(names: ["file"]))
        await drainMainActor()
        settle()
        XCTAssertEqual(field.text, "web", "An earlier save must not replace a newer unsent draft")
        attachHostedScreenshot(window, name: "legacy-newer-draft-after-reply")
    }

    func testToolsetPicker() async throws {
        // A settled choice renders the server's decision, including a lock within a multi-selection.
        do {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let catalog = try decoder.decode(ToolsetsCatalog.self, from: Data(#"{"toolsets":[{"name":"file","available":true,"selected":true,"group":"available","can_deselect":false},{"name":"web","available":true,"selected":true,"group":"available","can_deselect":true}],"selected_toolsets":["file","web"],"using_defaults":false,"default_toolsets":["file"]}"#.utf8))
            let window = try hostWindow(ComposerToolsetsSheet(loadCatalog: { _ in catalog }, onSave: { SessionToolsets(names: $0) }))
            defer { window.isHidden = true; window.rootViewController = nil }
            let file = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "toolset-file" }
            XCTAssertTrue(file.accessibilityTraits.contains(.notEnabled), "Settled eligibility comes from can_deselect, not the selection count")
        }
        let fixture = try FixtureApp(for: self)
        try await renderHostedPage("toolsets") {
            ComposerToolsetsSheet(loadCatalog: { query in
                try await fixture.client.fetchToolsetsCatalog(sessionID: "ui-fixture-session", toolsets: nil, query: query)
            }, onSave: { SessionToolsets(names: $0) })
        } prepare: { window in
            _ = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "toolset-web" }
        } inspect: { window, variant in
            _ = try await self.requireElement(in: window, label: "Toolsets")
            XCTAssertFalse(HostedAccessibility.labels(in: window).contains("Save"))
            XCTAssertFalse(HostedAccessibility.labels(in: window).contains("Cancel"))
            let file = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "toolset-file" }
            XCTAssertTrue(file.accessibilityTraits.contains(.notEnabled), "The last selected toolset cannot be removed")
            let labels = HostedAccessibility.labels(in: window).joined(separator: " ")
            XCTAssertTrue(labels.contains("Read and write files"))
            XCTAssertTrue(labels.contains("Unavailable tools: web_search"))
            if !HostedAccessibility.elements(in: window).contains(where: { HostedAccessibility.identifier(of: $0) == "toolset-todo" }) {
                self.attachHostedScreenshot(window, name: "toolsets-\(variant.name)-top")
                let list = try XCTUnwrap(window.firstView(ofType: UICollectionView.self))
                list.setContentOffset(CGPoint(x: 0, y: max(0, list.contentSize.height - list.bounds.height)), animated: false)
                self.settle()
            }
            let disabled = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "toolset-todo" }
            XCTAssertTrue(disabled.accessibilityTraits.contains(.notEnabled))
            XCTAssertTrue(HostedAccessibility.labels(in: window).contains("Not available"))
        }
    }

    func testLongCatalogSearchRendersTheServersFilteredRows() async throws {
        let searched = expectation(description: "search reached the catalog endpoint")
        let client = makeClient { request in
            let query = try apiTestJSONBody(from: request)["q"] as? String ?? ""
            let rows: [[String: Any]]
            if query.isEmpty {
                rows = (0..<13).map { ["name": "tool-\($0)", "description": "Description \($0)", "available": true, "selected": false, "group": "available"] }
            } else {
                XCTAssertEqual(query, "TASKS")
                if query == "TASKS" { searched.fulfill() }
                rows = [["name": "todo", "description": "Task lists", "available": false, "selected": false, "group": "not_available", "unavailable_reason": "disabled"]]
            }
            let body = try JSONSerialization.data(withJSONObject: ["toolsets": rows, "selected_toolsets": ["tool-0"], "using_defaults": true, "default_toolsets": ["tool-0"]])
            return apiTestJSONResponse(String(decoding: body, as: UTF8.self), for: request)
        }
        let window = try hostWindow(ComposerToolsetsSheet(loadCatalog: { query in
            try await client.fetchToolsetsCatalog(sessionID: nil, toolsets: nil, query: query)
        }, onSave: { SessionToolsets(names: $0) }))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Search"))
        let hasSearch = await awaitCondition { window.firstView(ofType: UITextField.self) != nil }
        XCTAssertTrue(hasSearch)
        let field = try XCTUnwrap(window.firstView(ofType: UITextField.self))
        field.becomeFirstResponder()
        field.insertText("TASKS")
        await fulfillment(of: [searched], timeout: 5)
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "toolset-todo" }
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains { HostedAccessibility.identifier(of: $0) == "toolset-tool-0" })
        attachHostedScreenshot(window, name: "toolsets-search")
    }

    func testComposerOpensToolsetsAndAppliesToggleWithoutClosingSheet() async throws {
        let fixture = try FixtureApp(for: self)
        let summary = SessionSummary(sessionId: "ui-fixture-session", title: "Toolset selection")
        let model = ChatViewModel(session: summary, server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        defer { model.cleanupPollingTasks() }
        await model.loadMessages()
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: UITestFixtureEnvironment.serverURL, onAPIError: { XCTFail("\($0)") },
                     loadsInitialMessages: false, viewModel: model)
        }.modelContainer(fixture.cache))
        let chip = try await requireElement(in: window, label: "Session toolsets")
        XCTAssertEqual(chip.accessibilityValue, "Profile defaults")
        HostedAccessibility.activate(chip)
        let web = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "toolset-web" }
        attachHostedScreenshot(window, name: "toolsets-before-toggle")
        if let control = web as? UISwitch {
            control.setOn(true, animated: false)
            control.sendActions(for: .valueChanged)
        } else {
            XCTAssertTrue(HostedAccessibility.activate(web))
        }
        let saved = await awaitCondition { model.sessionToolsets?.title == "2 toolsets" }
        XCTAssertTrue(saved)
        _ = try await requireElement(in: window, label: "Toolsets")
        attachHostedScreenshot(window, name: "toolsets-after-toggle")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let updatedChip = try await requireElement(in: window, label: "Session toolsets")
        XCTAssertEqual(updatedChip.accessibilityValue, "file, web")
    }
}
