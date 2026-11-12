import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Page layout, rather than pixel identity. The existing fixture intercepts every server request.
@MainActor
final class ScreenGalleryHostedTests: XCTestCase {
    private var fixture: FixtureApp!
    private var defaults: UserDefaults!
    private let server = UITestFixtureEnvironment.serverURL

    override func setUp() async throws {
        fixture = try FixtureApp(for: self)
        let name = "ScreenGalleryHostedTests.\(UUID())"
        defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    }

    func testInterfaceSettings() async throws { try await categories(in: .interface) }
    func testProfileSettings() async throws { try await categories(in: .profile) }
    func testServerSettings() async throws { try await categories(in: .server) }
    func testDeviceSettings() async throws { try await categories(in: .device) }

    func testModelsThinkingChoicePersistsFromTheVisibleControl() async throws {
        let window = try hostWindow(NavigationStack { ModelsSettingsView(server: server) })
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-models-show-thinking"
        }
        let toggle = try XCTUnwrap(window.firstView(ofType: UISwitch.self))
        XCTAssertTrue(toggle.isOn)
        toggle.setOn(false, animated: false)
        toggle.sendActions(for: .valueChanged)
        let saved = await awaitCondition {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/reasoning" }.count >= 2 }
        }
        XCTAssertTrue(saved)
        let status = try await fixture.client.reasoning()
        XCTAssertEqual(status.showReasoning, false)
        XCTAssertFalse(toggle.isOn)
        attachHostedScreenshot(window, name: "settings-models-thinking-hidden")
    }

    private func categories(in group: SettingsCategory.Group) async throws {
        for category in SettingsCategory.rootCategories where category.group == group {
            try await page("settings-\(category.id)", title: category.title) {
                SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .category(category))
            }
        }
    }

    func testSettingsRootAndAccounts() async throws {
        try await page("settings", title: "Settings") {
            SettingsView(server: server, selection: .constant(nil))
        }
        try await page("settings-user-profile", title: "User Profile") {
            SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .userProfile)
        }
        try await page("settings-apple-account", title: "Apple Account") {
            SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .appleAccount)
        }
    }

    func testAdditionalSettings() async throws {
        try await page("settings-auxiliary-models", title: "Auxiliary Models") {
            AuxiliaryModelsSettingsView(server: server)
        }
        try await page("settings-quota-widget", title: "Customization") {
            SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .providerQuotaWidget)
        }
        try await page("settings-sidebar-quotas", title: "Sidebar Quotas") {
            ProviderQuotaSidebarDisplayView()
        }
    }

    func testTasks() async throws {
        let model = TasksViewModel(server: server, client: fixture.client)
        await model.load()
        try await page("tasks", title: "Tasks") {
            TasksView(viewModel: model, selection: .constant(nil), onAPIError: { XCTFail("\($0)") })
        }
    }

    func testKanban() async throws {
        let model = KanbanFeatureState(server: server, defaults: defaults, onAPIError: { XCTFail("\($0)") })
        await model.loadIfNeeded()
        // The board picker replaces the navigation title; Triage is the first status section.
        try await page("kanban", title: "Triage") { KanbanStatusFocusView(model: model) }
    }

    func testSkills() async throws {
        let model = SkillsViewModel(client: fixture.client)
        await model.load()
        try await page("skills", title: "Skills") {
            SkillsView(viewModel: model, selection: .constant(nil), onAPIError: { XCTFail("\($0)") })
        }
    }

    func testMemory() async throws {
        let model = MemoryViewModel(server: server, client: fixture.client)
        await model.load()
        try await page("memory", title: "Memory") {
            MemoryView(viewModel: model, selection: .constant(nil), onAPIError: { XCTFail("\($0)") })
        }
    }

    func testInsights() async throws {
        for tab in ["Quotas", "Usage"] {
            try await page("insights-\(tab.lowercased())", title: "Insights", prepare: { window in
                if tab == "Usage" {
                    HostedAccessibility.activate(try await self.requireElement(in: window, label: "Usage"))
                }
                _ = try await self.requireElement(in: window) {
                    tab == "Usage" ? $0.accessibilityLabel?.hasPrefix("Sessions, ") == true
                        : HostedAccessibility.identifier(of: $0) == "provider-quota-row-ui-fixture-source"
                }
            }) {
                InsightsView(server: server, onAPIError: { XCTFail("\($0)") })
            }
        }
    }

    func testWorkspaceAndKanbanEditors() async throws {
        let registry = WorkspaceRegistryViewModel(client: fixture.client)
        await registry.load()
        try await page("workspace-manager", title: "Manage Workspaces") {
            WorkspaceManagerView(viewModel: registry, onRegistryChanged: {})
        }
        try await page("workspace-add", title: "Add Workspace") { WorkspaceAddSheet(viewModel: registry) }
        try await page("workspace-picker", title: "Choose Workspace") {
            ComposerWorkspacePickerSheet(workspaceRoots: [], selectedWorkspacePath: nil, suggestions: [],
                                         onLoadSuggestions: { _ in }, onSelect: { _ in })
        }
        let card = try JSONDecoder().decode(KanbanCard.self, from: Data(#"{"card_id":"gallery-card","status":"running","title":"Fixture card"}"#.utf8))
        let editor = KanbanCardEditorState(mode: .edit(cardID: "gallery-card"), board: "fixture", client: fixture.client, card: card)
        try await page("kanban-card-editor", title: "Edit Card") {
            KanbanCardEditorView(state: editor, allowsMutation: true, onSaved: {})
        }
        let model = KanbanFeatureState(server: server, defaults: defaults, onAPIError: { XCTFail("\($0)") })
        await model.loadIfNeeded()
        try await page("kanban-board-editor", title: "Create") { KanbanBoardEditorView(model: model, mode: .create) }
        try await page("kanban-board-manager", title: "Manage") { KanbanBoardManagementView(model: model) }
        try await page("task-editor", title: "New Task") {
            CronJobEditorSheet(title: "New Task", client: fixture.client, draft: CronJobEditorDraft(),
                               saveTitle: "Create", isSaving: false, errorMessage: nil, onSave: { _ in false })
        }
        let snapshot = try JSONDecoder().decode(ContextWindowSnapshot.self, from: Data(#"{"estimated_cost":0.455}"#.utf8))
        try await renderHostedPage("context-cost") {
            ContextWindowPopover(snapshot: snapshot)
        } inspect: { window, _ in
            _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("$0.4550") == true }
        }
    }

    func testDecisions() async throws {
        let model = DecisionsListModel(client: fixture.client)
        await model.load()
        try await page("decisions", title: "Decisions") {
            DecisionsListView(model: model, selection: .constant(nil), openChat: { _ in }, onAPIError: { XCTFail("\($0)") })
        }
    }

    private func page<Content: View>(
        _ name: String, title: String,
        prepare: (UIWindow) async throws -> Void = { _ in },
        @ViewBuilder content: () -> Content
    ) async throws {
        func reads(_ path: String) -> Int {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == path }.count }
        }
        var settingsReads = reads("/api/settings")
        var updateReads = reads("/api/updates/check")
        try await renderHostedPage(name) {
            NavigationStack { content() }
                .defaultAppStorage(defaults)
                .environment(\.scenePhase, .active)
                .modelContainer(fixture.cache)
        } prepare: { window in
            try await prepare(window)
            let loadedText: String?
            switch name {
            case "settings":
                let answered = await awaitCondition { reads("/api/settings") > settingsReads }
                XCTAssertTrue(answered, "The directory must load its server-provided categories")
                settingsReads = reads("/api/settings")
                loadedText = nil
            case "settings-tools": loadedText = "Agents can approve other chats' commands"
            case "settings-chat": loadedText = "Max Tokens"
            case "settings-models": loadedText = "fixture-model"
            case "settings-profiles": loadedText = "Fixture Profile"
            case "settings-workspaces": loadedText = "Fixture Workspace"
            case "settings-auxiliary-models": loadedText = "legacy/vision-model"
            case "settings-notifications": loadedText = "iOS permission not requested."
            case "settings-system":
                // Wait for both the shared preferences and this variant's update status.
                let answered = await awaitCondition {
                    reads("/api/settings") > settingsReads && reads("/api/updates/check") > updateReads
                }
                XCTAssertTrue(answered, "\(name): this variant's settings and update requests did not finish")
                settingsReads = reads("/api/settings")
                updateReads = reads("/api/updates/check")
                loadedText = "Check for Updates"
            default: loadedText = nil
            }
            if let loadedText {
                _ = try await requireElement(in: window, "\(name): loaded content is missing") {
                    $0.accessibilityLabel?.contains(loadedText) == true
                }
            }
            if name == "settings-models" {
                for identifier in ["settings-models-default-reasoning", "settings-models-show-thinking"] {
                    _ = try await requireElement(in: window, "Models is missing \(identifier)") {
                        HostedAccessibility.identifier(of: $0) == identifier
                    }
                }
            }
        } inspect: { window, variant in
            let banned: [String]
            switch name {
            case "insights-usage": banned = ["Source: server insights"]
            case "workspace-manager", "settings-workspaces": banned = ["Removing a workspace only unregisters"]
            case "workspace-add", "workspace-picker": banned = ["Suggestions are limited to trusted workspace roots"]
            case "kanban-card-editor": banned = ["Choose a permitted Status", "Workspace, Skills, Maximum Runtime, and Prerequisite are set"]
            case "kanban-board-editor": banned = ["Creating a Board does not make it active."]
            case "kanban-board-manager": banned = ["Browsing a Board stays local"]
            default: banned = []
            }
            if !banned.isEmpty {
                let scroll = window.rootViewController?.view.firstView(ofType: UIScrollView.self) { $0.bounds.height > 200 }
                var inspectedHelp = false
                repeat {
                    settle(window: window)
                    let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
                    for text in banned { XCTAssertFalse(labels.contains(text), "\(name)-\(variant.name): obsolete explanation \(text)") }
                    if name == "kanban-card-editor", !inspectedHelp,
                       let help = HostedAccessibility.element(in: window, label: "About Execution") {
                        XCTAssertFalse(help.accessibilityTraits.contains(.notEnabled), "Execution help must remain enabled for read-only fields")
                        HostedAccessibility.activate(help)
                        _ = try await requireElement(in: window) {
                            $0.accessibilityLabel?.hasPrefix("Workspace, Skills, Maximum Runtime, and Prerequisite are set") == true
                        }
                        attachHostedScreenshot(window, name: "kanban-execution-help-\(variant.name)")
                        let presented = await presentedAlert(in: window)
                        let alert = try XCTUnwrap(presented)
                        XCTAssertTrue(HostedAccessibility.tap("OK", in: alert))
                        let dismissed = await awaitCondition {
                            !HostedAccessibility.labels(in: window).contains {
                                $0.hasPrefix("Workspace, Skills, Maximum Runtime, and Prerequisite are set")
                            }
                        }
                        XCTAssertTrue(dismissed, "Execution help did not dismiss")
                        inspectedHelp = true
                    }
                    guard let scroll else { break }
                    let bottom = max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
                    if scroll.contentOffset.y >= bottom - 1 { break }
                    scroll.setContentOffset(CGPoint(x: 0, y: min(bottom, scroll.contentOffset.y + scroll.bounds.height * 0.8)), animated: false)
                } while true
                if name == "kanban-card-editor" { XCTAssertTrue(inspectedHelp, "Missing Execution section help") }
                if let scroll {
                    scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
                }
                settle(window: window)
            }
            let heading = try await requireElement(in: window, label: title)
            settle(window: window)
            let bounds = window.bounds
            let headingFrame = window.convert(heading.accessibilityFrame, from: window.screen.coordinateSpace)
            XCTAssertTrue(bounds.intersects(headingFrame), "\(name)-\(variant.name): title \(title) is off screen: \(headingFrame)")
            for element in HostedAccessibility.elements(in: window) {
                let frame = window.convert(element.accessibilityFrame, from: window.screen.coordinateSpace)
                // A scroll view can keep rows above or below the viewport mounted.
                guard frame.maxY > bounds.minY, frame.minY < bounds.maxY else { continue }
                let context = "\(name)-\(variant.name): \(element.accessibilityLabel ?? "unlabelled") at \(frame), host \(bounds)"
                // Horizontal tab strips intentionally keep partially visible neighbours mounted.
                XCTAssertLessThanOrEqual(frame.width, bounds.width + 1, context)
                if element.accessibilityLabel?.isEmpty == false {
                    XCTAssertGreaterThan(frame.width, 0, context)
                }
            }
        }
    }
}
