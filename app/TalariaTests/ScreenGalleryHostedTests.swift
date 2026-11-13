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

    func testLogsShowsServerTailAndControls() async throws {
        _ = try XCTUnwrap(SettingsCategory(rawValue: "logs"), "Settings must offer the server log tail")
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel == "Settings" && $0.accessibilityHint == "Long press to switch servers."
        })
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        for _ in 0..<4 {
            if HostedAccessibility.element(in: window, identifier: "settings-category-logs") != nil { break }
            if let scroll = window.rootViewController?.presentedViewController?.view.firstView(ofType: UIScrollView.self) {
                let bottom = max(0, scroll.contentSize.height - scroll.bounds.height)
                scroll.setContentOffset(CGPoint(x: 0, y: min(bottom, scroll.contentOffset.y + 400)), animated: false)
                settle(window: window)
            }
        }
        HostedAccessibility.activate(try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-category-logs" })
        for id in ["settings-logs-file", "settings-logs-lines", "settings-logs-text"] {
            _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == id }
        }
        func reads() -> Int {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/logs" }.count }
        }
        var before = reads()
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.toolbarAction("Refresh", in: window)))
        let toolbarRefreshed = await awaitCondition { reads() > before }
        XCTAssertTrue(toolbarRefreshed, "The toolbar must reload the selected tail")
        before = reads()
        let pull = try XCTUnwrap(window.rootViewController?.presentedViewController?.view.firstView(ofType: UIRefreshControl.self),
                                "Logs must support pull to refresh")
        pull.sendActions(for: .valueChanged)
        let pullRefreshed = await awaitCondition { reads() > before }
        XCTAssertTrue(pullRefreshed, "Pull to refresh must reach the same log reader")
        attachHostedScreenshot(window, name: "settings-logs-opened-from-settings")
    }

    func testLogsEmptyHintAndRefusalRetry() async throws {
        fixture = try FixtureApp(["--ui-test-empty-logs", "--ui-test-refuse-first-logs"], for: self)
        let window = try hostWindow(NavigationStack {
            LogsSettingsView(server: server).environment(\.scenePhase, .active)
        })
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Fixture log access refused") == true }
        attachHostedScreenshot(window, name: "settings-logs-refused")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Try Again"))
        _ = try await requireElement(in: window, label: "Bootstrap has not written a log yet.")
        attachHostedScreenshot(window, name: "settings-logs-empty")
    }

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

    func testProfilesOpenDetailAndEditFromTheList() async throws {
        try await renderHostedPage("profiles-edit") {
            NavigationStack {
                DefaultProfilePickerView(server: server, currentDefaultProfileName: nil, onSave: { _ in })
            }
        } inspect: { window, variant in
            _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Fixture Profile") == true }
            attachHostedScreenshot(window, name: "profiles-list-\(variant.name)")
            let row = try await requireElement(in: window, "Profiles must offer a detail destination") {
                HostedAccessibility.identifier(of: $0) == "settings-profile-row-fixture-profile"
            }
            HostedAccessibility.activate(row)
            _ = try await requireElement(in: window) {
                HostedAccessibility.identifier(of: $0) == "settings-profile-detail-name"
            }
            _ = try await requireElement(in: window) {
                HostedAccessibility.identifier(of: $0) == "settings-profile-detail-assistant-name"
            }
            let actions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
            XCTAssertFalse(actions.contains { $0.title == "Delete" }, "The default profile cannot be deleted")
            attachHostedScreenshot(window, name: "profiles-detail-\(variant.name)")
            let edit = try XCTUnwrap(HostedAccessibility.toolbarAction("Edit", in: window))
            HostedAccessibility.activate(edit)
            _ = try await requireElement(in: window, label: "Display Name")
        }
    }

    func testProfileEditSheetSavesAndNonDefaultHasNoAssistantName() async throws {
        let model = ProfilesSettingsModel(client: fixture.client)
        await model.load()
        let window = try hostWindow(NavigationStack {
            ProfileDetailView(server: server, name: "fixture-work", model: model, use: { _, _ in }, missing: { XCTFail("Unexpected missing profile") })
        })
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-detail-name" }
        XCTAssertNil(HostedAccessibility.elements(in: window).first { HostedAccessibility.identifier(of: $0) == "settings-profile-detail-assistant-name" })
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.toolbarAction("Edit", in: window)))
        _ = try await requireElement(in: window, label: "Display Name")
        let name = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.text == "Research Bot" })
        XCTAssertFalse(name.isEnabled, "Bot Mode's title disables the display-name field")
        attachHostedScreenshot(window, name: "profiles-edit-overridden")
        let description = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.text == "Finds primary sources." })
        description.text = String(repeating: "e\u{301}", count: 141)
        description.sendActions(for: .editingChanged)
        let bounded = await awaitCondition { description.text?.unicodeScalars.count == ProfileNameRules.descriptionLimit }
        XCTAssertTrue(bounded, "The editor clamps the server's code-point limit before saving")
        description.text = "Updated research identity"
        description.sendActions(for: .editingChanged)
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.toolbarAction("Save", in: window)))
        let saved = await awaitCondition { model.profiles.first { $0.name == "fixture-work" }?.description == "Updated research identity" }
        XCTAssertTrue(saved)
        await model.load()
        XCTAssertEqual(model.profiles.first { $0.name == "fixture-work" }?.description, "Updated research identity")
        attachHostedScreenshot(window, name: "profiles-after-edit")
    }

    func testProfileDeletionConfirmsBeforeRemovingAndReturnsToList() async throws {
        var settingsPresented = true
        let window = try hostWindow(Text("Fixture Settings Host").sheet(isPresented: Binding(
            get: { settingsPresented }, set: { settingsPresented = $0 }
        )) {
            NavigationStack {
                DefaultProfilePickerView(server: self.server, currentDefaultProfileName: nil, onSave: { _ in })
            }
        })
        HostedAccessibility.activate(try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-profile-row-fixture-work"
        })
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-detail-name" }
        let actions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
        HostedAccessibility.activate(try XCTUnwrap(actions.first { $0.title == "Delete" }))
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented)
        XCTAssertTrue(alert.title?.contains("Research Bot") == true)
        let before = try await fixture.client.profiles()
        XCTAssertTrue(before.profiles?.contains { $0.name == "fixture-work" } == true, "Opening confirmation must not delete")
        attachHostedScreenshot(window, name: "profiles-delete-confirmation")
        XCTAssertTrue(HostedAccessibility.tap("Delete", in: alert))
        _ = try await requireElement(in: window, label: "Profiles")
        XCTAssertTrue(settingsPresented, "Deleting must return to the list without dismissing Settings")
        let gone = await awaitNoElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-row-fixture-work" }
        XCTAssertTrue(gone)
        let after = try await fixture.client.profiles()
        XCTAssertFalse(after.profiles?.contains { $0.name == "fixture-work" } == true)
        attachHostedScreenshot(window, name: "profiles-after-delete")
    }

    func testProfileDetailDismissesWhenARefreshFindsItMissing() async throws {
        let model = ProfilesSettingsModel(client: fixture.client)
        await model.load()
        var missing = false
        let window = try hostWindow(NavigationStack {
            NavigationLink("Open profile") {
                ProfileDetailView(server: server, name: "fixture-work", model: model, use: { _, _ in }, missing: { missing = true })
            }
        })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Open profile"))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-detail-name" }
        _ = try await fixture.client.deleteProfile(name: "fixture-work")
        await model.load()
        let reported = await awaitCondition { missing }
        XCTAssertTrue(reported)
        _ = try await requireElement(in: window, label: "Open profile")
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

    func testSettingsSearchResultsAndEmptyState() async throws {
        for query in ["thinking", "not-a-real-setting-87321"] {
            try await page(query == "thinking" ? "settings-search-results" : "settings-search-empty", title: "Settings", prepare: { window in
                let field = try XCTUnwrap(window.firstView(ofType: UISearchTextField.self))
                field.text = query
                field.sendActions(for: .editingChanged)
                if query == "thinking" {
                    _ = try await requireElement(in: window) {
                        HostedAccessibility.identifier(of: $0) == "settings-search-settings-chat-expand-thinking-by-default"
                    }
                } else {
                    _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("No Results") == true }
                }
            }) {
                SettingsView(server: server, selection: .constant(nil))
            }
        }
    }

    func testComposerModelPicker() async throws {
        let preferences = SettingsModelPickerViewModel(client: fixture.client, favorites: .shared)
        await preferences.load()
        try await page("composer-model-picker", title: "Choose Model", wrapsNavigation: false, prepare: { window in
            _ = try await self.requireElement(in: window, label: "Remove Fixture Model from favorites")
        }) {
            ComposerModelPickerSheet(
                client: fixture.client, catalog: preferences, selectedModelID: "fixture-model",
                selectedModelProviderID: "fixture-provider", selectedModelOptionID: "fixture-model",
                onSelect: { _ in }, keepsSelectionOpen: true, showsReasoningControl: true,
                selectedReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"]
            )
        }
    }

    func testComposerEffortChoices() async throws {
        try await page("composer-effort", title: "Effort", wrapsNavigation: false, prepare: { window in
            let row = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-model-effort" }
            XCTAssertTrue(HostedAccessibility.activate(row))
            _ = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-effort-high" }
        }) {
            ComposerModelPickerSheet(client: fixture.client, selectedModelID: "fixture-model",
                selectedModelProviderID: "fixture-provider", selectedModelOptionID: "fixture-model",
                onSelect: { _ in }, keepsSelectionOpen: true, showsReasoningControl: true,
                selectedReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"])
        }
    }

    func testAdditionalSettings() async throws {
        try await page("settings-default-model", title: "Default Model", prepare: { window in
            let row = try await self.requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Default Model") == true }
            XCTAssertTrue(HostedAccessibility.activate(row))
            _ = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-model" }
        }) {
            ModelsSettingsView(server: server)
        }
        try await page("settings-auxiliary-models", title: "Auxiliary Models") {
            AuxiliaryModelsSettingsView(server: server)
        }
        try await page("settings-auxiliary-task-editor", title: "Vision", prepare: { window in
            let row = try await self.requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Vision") == true }
            XCTAssertTrue(HostedAccessibility.activate(row))
            _ = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "auxiliary-edit-reasoning" }
        }) { AuxiliaryModelsSettingsView(server: server) }
        try await page("settings-auxiliary-model-picker", title: "Model", prepare: { window in
            let row = try await self.requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Vision") == true }
            XCTAssertTrue(HostedAccessibility.activate(row))
            let model = try await self.requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "auxiliary-edit-model" }
            XCTAssertTrue(HostedAccessibility.activate(model))
            _ = try await self.requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("legacy/vision-model") == true }
        }) {
            AuxiliaryModelsSettingsView(server: server)
        }
        try await page("settings-quota-widget", title: "Customization") {
            SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .providerQuotaWidget)
        }
        try await page("settings-sidebar-quotas", title: "Sidebar Quotas") {
            ProviderQuotaSidebarDisplayView()
        }
        let profile = try XCTUnwrap(ProviderQuotaWidgetProfileStore.saveCurrent(name: "Fixture Widget Profile"))
        defer { ProviderQuotaWidgetProfileStore.delete(id: profile.id) }
        try await page("settings-widget-profiles", title: "Widget Profiles") {
            ProviderQuotaWidgetProfilesView()
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
        _ name: String, title: String, wrapsNavigation: Bool = true,
        prepare: (UIWindow) async throws -> Void = { _ in },
        @ViewBuilder content: () -> Content
    ) async throws {
        func reads(_ path: String) -> Int {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == path }.count }
        }
        var settingsReads = reads("/api/settings")
        var updateReads = reads("/api/updates/check")
        try await renderHostedPage(name) {
            Group {
                if wrapsNavigation { NavigationStack { content() } }
                else { content() }
            }
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
            case "settings-logs":
                for id in ["settings-logs-file", "settings-logs-lines", "settings-logs-text"] {
                    _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == id }
                }
                loadedText = "Log text"
            case "settings-providers": loadedText = SettingsIndex.providersOverPaceAt.title
            case "settings-tools": loadedText = "Agents can approve other chats' commands"
            case "settings-chat": loadedText = "Send While Responding"
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
        } inspect: { window, variant in
            let controlIDs: [String]
            switch name {
            case "settings-models": controlIDs = ["settings-models-default-reasoning", "settings-models-show-thinking"]
            case "settings-default-model", "settings-auxiliary-model-picker": controlIDs = ["settings-model-visibility-fixture-model"]
            default: controlIDs = []
            }
            if !controlIDs.isEmpty {
                let scroll = try XCTUnwrap(window.firstView(ofType: UICollectionView.self))
                let initialOffset = scroll.contentOffset
                for identifier in controlIDs {
                    _ = try await requireElementScrolling(in: window, "Models is missing \(identifier)") {
                        let frame = window.convert($0.accessibilityFrame, from: window.screen.coordinateSpace)
                        let visible = window.convert(scroll.bounds.inset(by: scroll.adjustedContentInset), from: scroll)
                        return HostedAccessibility.identifier(of: $0) == identifier
                            && frame.width > 0 && frame.height > 0 && visible.contains(frame)
                    }
                    attachHostedScreenshot(window, name: "\(name)-\(identifier)-\(variant.name)")
                }
                scroll.setContentOffset(initialOffset, animated: false)
                settle(window: window)
            }
            if name == "settings-logs", variant.name == "phone-ax5" {
                attachHostedScreenshot(window, name: "settings-logs-phone-ax5-controls")
                let scroll = try XCTUnwrap(window.firstView(ofType: UICollectionView.self))
                scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height)), animated: false)
                settle(window: window)
                let tail = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-logs-text" }
                let frame = window.convert(tail.accessibilityFrame, from: window.screen.coordinateSpace)
                XCTAssertTrue(window.bounds.intersects(frame), "The log tail must remain reachable at the largest text size")
                let text = try XCTUnwrap(window.firstView(ofType: UITextView.self) { $0.text.contains("Fixture log line 500") },
                                         "The full log must be readable and selectable at the largest text size")
                XCTAssertTrue(text.isSelectable)
                XCTAssertFalse(text.isEditable)
                let end = text.caretRect(for: text.endOfDocument)
                XCTAssertTrue(end.maxY > text.bounds.minY && end.minY < text.bounds.maxY,
                              "The newest line must be laid out inside the visible text viewport")
                XCTAssertTrue(text.contentSize.width.isFinite)
            }
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
