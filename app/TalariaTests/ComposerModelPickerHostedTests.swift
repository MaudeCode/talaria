import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// TAL-935: the composer model picker shows the server's rate limits and quota levels (TAL-807) on the provider
/// headings and the cooling-down model rows.
@MainActor
final class ComposerModelPickerHostedTests: APIClientTestCase {
    func testModelButtonOpensOptionsBeforeTheCatalogAndKeepsSelectionOpen() async throws {
        continueAfterFailure = false
        let fixture = try FixtureApp(for: self)
        let summary = try await fixture.session()
        let model = ChatViewModel(session: summary, server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        defer { model.cleanupPollingTasks() }
        let window = try hostWindow(fixture.chat(summary, viewModel: model))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let button = try await requireElement(in: window, label: "Select model")
        attachHostedScreenshot(window, name: "composer-single-model-button")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Select reasoning effort"), "Model and effort must share one strip control")
        XCTAssertTrue(HostedAccessibility.activate(button))
        let opened = await awaitCondition {
            HostedAccessibility.element(in: window, label: "Options") != nil
        }
        XCTAssertTrue(opened, "One tap on the model button must open the sheet with Options before the catalog")
        let effort = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-model-effort" }
        let heading = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Fixture Provider") == true }
        XCTAssertLessThan(effort.accessibilityFrame.minY, heading.accessibilityFrame.minY)
        let search = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.placeholder == "Search models" })
        XCTAssertTrue(search.becomeFirstResponder())
        search.text = "Alternative"
        search.sendActions(for: .editingChanged)
        _ = try await requireElement(in: window, label: "Clear model search")
        let row = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-alternative" }
        XCTAssertTrue(HostedAccessibility.activate(row))
        let selected = await awaitCondition {
            HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-alternative")?.accessibilityTraits.contains(.selected) == true
        }
        XCTAssertTrue(selected, "The optimistic selection must update inside the still-open sheet")
        XCTAssertEqual(window.firstView(ofType: UITextField.self) { $0.placeholder == "Search models" }?.text, "Alternative",
                       "Selecting a model must preserve the open picker's search")
        _ = try await requireElement(in: window, label: "Options")
        attachHostedScreenshot(window, name: "composer-model-selected-sheet-stays-open")
        XCTAssertTrue(HostedAccessibility.activate(effort))
        let high = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-effort-high" }
        XCTAssertTrue(HostedAccessibility.activate(high))
        let effortChanged = await awaitCondition { model.selectedReasoningEffort == "high" }
        XCTAssertTrue(effortChanged)
        attachHostedScreenshot(window, name: "composer-effort-selected")
    }

    func testNewChatModelSelectionKeepsSearchUntilSheetIsDismissed() async throws {
        let fixture = try FixtureApp(for: self)
        let list = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        let window = try hostWindow(NavigationStack {
            PendingNewChatView(isExplicit: false, server: UITestFixtureEnvironment.serverURL, viewModel: list,
                onAPIError: { XCTFail("\($0)") }, draftStore: fixture.environment.draftStore)
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
        let button = try await requireElement(in: window, label: "Select model")
        XCTAssertTrue(HostedAccessibility.activate(button))
        let search = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.placeholder == "Search models" })
        XCTAssertTrue(search.becomeFirstResponder())
        search.text = "Alternative"
        search.sendActions(for: .editingChanged)
        _ = try await requireElement(in: window, label: "Clear model search")
        let option = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-alternative" }
        XCTAssertTrue(HostedAccessibility.activate(option))
        let selected = await awaitCondition {
            HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-alternative")?.accessibilityTraits.contains(.selected) == true
        }
        XCTAssertTrue(selected)
        XCTAssertEqual(window.firstView(ofType: UITextField.self) { $0.placeholder == "Search models" }?.text, "Alternative")
    }

    /// Settings and the already-mounted composer share the profile's authoritative favorites.
    func testComposerReadsAndWritesTheSettingsProfileFavorites() async throws {
        continueAfterFailure = false
        let fixture = try FixtureApp(for: self)
        let legacyKey = "talaria.favoriteModels"
        let saved = UserDefaults.standard.object(forKey: legacyKey)
        UserDefaults.standard.removeObject(forKey: legacyKey)
        defer { UserDefaults.standard.set(saved, forKey: legacyKey) }
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let modelButton = try await requireElement(in: window, label: "Select model")
        XCTAssertTrue(HostedAccessibility.activate(modelButton))
        let serverStarVisible = await awaitCondition {
            HostedAccessibility.element(in: window, label: "Remove Fixture Model from favorites") != nil
        }
        XCTAssertTrue(serverStarVisible, "The composer must show the server favorite even when this device has no legacy favorites")
        let persisted = expectation(description: "Composer preference write acknowledged")
        let observer = NotificationCenter.default.addObserver(forName: SettingsModelPickerViewModel.preferencesDidChange, object: nil, queue: .main) { _ in persisted.fulfill() }
        defer { NotificationCenter.default.removeObserver(observer) }
        let removeFavorite = try await requireElement(in: window, label: "Remove Fixture Model from favorites")
        XCTAssertTrue(HostedAccessibility.activate(removeFavorite))
        _ = try await requireElement(in: window, label: "Add Fixture Model to favorites")
        await fulfillment(of: [persisted], timeout: 10)
        NotificationCenter.default.removeObserver(observer)
        let afterComposerWrite = try await fixture.client.settingsModelPicker(search: "", provider: "", favorites: false, showHidden: true, live: false)
        XCTAssertEqual(afterComposerWrite.favorites, [], "Composer writes must reach the same server profile as Settings")
        let settings = SettingsModelPickerViewModel(client: fixture.client, favorites: .shared)
        await settings.load()
        let model = try XCTUnwrap(settings.groups.first?.models.first { $0.id == "fixture-model" })
        await settings.toggleFavorite(model)
        _ = try await requireElement(in: window, label: "Remove Fixture Model from favorites")
        XCTAssertNil(UserDefaults.standard.object(forKey: legacyKey), "A server preference write must never restart local favorites persistence")
    }

    func testPickerAndQuotaRowShowRecoveryAuthority() async throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let models = try decoder.decode(ModelsResponse.self, from: Data(#"{"availability":{"status":"stale","authoritative":false,"generation":"synthetic","unavailable_reason":"Provider data is temporarily unavailable. Showing last-confirmed data."},"default_model":"gpt-6.1-sol","groups":[{"provider":"OpenAI Codex","provider_id":"openai-codex","models":[{"id":"gpt-6.1-sol","label":"GPT-6.1 Sol"}]}]}"#.utf8))
        func picker(_ groups: [ModelCatalogGroup]) async throws -> ComposerModelPickerSheet {
            let state = try await catalog(groups)
            return ComposerModelPickerSheet(client: APIClient(baseURL: URL(string: "https://example.test")!), catalog: state,
                selectedModelID: "gpt-6.1-sol", selectedModelProviderID: "openai-codex", selectedModelOptionID: "gpt-6.1-sol", onSelect: { _ in })
        }
        let baseline = try hostWindow(try await picker([ModelCatalogGroup(id: "openai-codex", name: models.catalogGroups[0].name, providerID: "openai-codex", models: models.catalogGroups[0].models)]))
        attachHostedScreenshot(baseline, name: "catalog-before")
        baseline.isHidden = true
        let window = try hostWindow(try await picker(models.catalogGroups))
        XCTAssertTrue(HostedAccessibility.labels(in: window).contains { $0.contains("Last-confirmed data") })
        XCTAssertTrue(waitUntil { HostedAccessibility.labels(in: window).contains { $0.contains("GPT-6.1 Sol") } })
        attachHostedScreenshot(window, name: "catalog-recovery-after")
        window.isHidden = true
        let quota = try decoder.decode(ProviderQuotasResponse.self, from: Data(#"{"sources":[{"source_id":"qsrc_test","provider_id":"openai-codex","provider_label":"OpenAI Codex","status":"stale","unavailable_reason":"Provider data is temporarily unavailable. Showing last-confirmed data.","windows":[{"label":"Session","remaining_percent":75}]}]}"#.utf8))
        let row = try hostWindow(NavigationStack {
            List {
                ProviderQuotaWindowsView(source: quota.sources[0], scopeID: "qscope_test", percentageMode: .remaining, referenceDate: Date())
            }.navigationTitle("Provider quotas")
        })
        XCTAssertTrue(HostedAccessibility.labels(in: row).contains { $0.contains("last-confirmed data") })
        attachHostedScreenshot(row, name: "quota-recovery-after")
    }

    func testPickerShowsRateLimitsAndQuotaLevelsFromTheCatalog() async throws {
        let today = Calendar.current.startOfDay(for: Date())
        let modelResetsAt = today.addingTimeInterval(23 * 3600 + 59 * 60)
        let accountResetsAt = today.addingTimeInterval(2 * 86_400 + 9 * 3600)
        let groups = [
            ModelCatalogGroup(
                id: "anthropic",
                name: "Anthropic",
                providerID: "anthropic",
                models: [
                    ModelCatalogOption(id: "claude-opus-4.1", displayName: "Claude Opus 4.1", providerID: "anthropic", bareID: "claude-opus-4.1", limitResetsAt: modelResetsAt),
                    ModelCatalogOption(id: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", providerID: "anthropic", bareID: "claude-sonnet-4.5")
                ],
                quotaLevel: .warning
            ),
            ModelCatalogGroup(
                id: "openai-codex",
                name: "OpenAI Codex",
                providerID: "openai-codex",
                models: [ModelCatalogOption(id: "@openai-codex:gpt-5.5", displayName: "GPT-5.5", providerID: "openai-codex", bareID: "gpt-5.5")],
                accountLimitResetsAt: accountResetsAt
            ),
            ModelCatalogGroup(
                id: "nous",
                name: "Nous",
                providerID: "nous",
                models: [ModelCatalogOption(id: "@nous:hermes-4", displayName: "Hermes 4", providerID: "nous", bareID: "hermes-4")],
                quotaLevel: .critical
            )
        ]
        let state = try await catalog(groups)
        let window = try hostWindow(
            ComposerModelPickerSheet(
                client: APIClient(baseURL: URL(string: "https://example.test")!), catalog: state,
                selectedModelID: nil,
                selectedModelProviderID: nil,
                selectedModelOptionID: nil,
                onSelect: { _ in }
            )
        )

        let accountTime = accountResetsAt.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        let headings = HostedAccessibility.labels(in: window)
        XCTAssertTrue(headings.contains { $0.contains("OpenAI Codex") && $0.contains("Limited until \(accountTime)") }, "Labels: \(headings)")
        XCTAssertTrue(headings.contains { $0.contains("Anthropic") && $0.contains("Low quota") }, "Labels: \(headings)")
        XCTAssertTrue(headings.contains { $0.contains("Nous") && $0.contains("Quota nearly out") }, "Labels: \(headings)")

        let modelTime = modelResetsAt.formatted(date: .omitted, time: .shortened)
        XCTAssertTrue(waitUntil {
            HostedAccessibility.labels(in: window).contains { $0.contains("Claude Opus 4.1") && $0.contains("Limited until \(modelTime)") }
        }, "Labels: \(HostedAccessibility.labels(in: window))")
        XCTAssertFalse(
            HostedAccessibility.labels(in: window).contains { $0.contains("Claude Sonnet 4.5") && $0.contains("Limited until") },
            "A model without a limit shows one"
        )
    }
    func testSharedCatalogRendersProviderGlyphsMixedFavoritesAndAnUnattributedSelection() async throws {
        let known = ModelCatalogOption(id: "known", displayName: "Shared Model", providerID: "openai-codex", bareID: "shared", isFavorite: true, preferencesEditable: true)
        let unknown = ModelCatalogOption(id: "unknown", displayName: "Shared Model", providerID: "synthetic-provider", bareID: "shared", isFavorite: true, preferencesEditable: true)
        let plain = ModelCatalogOption(id: "unattributed", displayName: "Unattributed Model", providerID: nil)
        let groups = [ModelCatalogGroup(id: "openai-codex", name: "OpenAI Codex", providerID: "openai-codex", models: [known]),
            ModelCatalogGroup(id: "synthetic-provider", name: "Synthetic Provider", providerID: "synthetic-provider", models: [unknown]),
            ModelCatalogGroup(id: "unattributed", name: "Models", providerID: nil, models: [plain])]
        let state = try await catalog(groups, favorites: [known, unknown])
        try await renderHostedPage("composer-provider-glyphs", variants: HostedVariant.gallery) {
            ComposerModelPickerSheet(client: APIClient(baseURL: URL(string: "https://example.test")!), catalog: state,
                selectedModelID: plain.id, selectedModelProviderID: nil, selectedModelOptionID: plain.id, onSelect: { _ in })
        } inspect: { window, variant in
            _ = try await requireElement(in: window, label: "Favorites")
            attachHostedScreenshot(window, name: "composer-provider-glyphs-top-\(variant.name)")
            _ = try await requireElementScrolling(in: window, "The provider-less selected model must remain reachable") {
                HostedAccessibility.identifier(of: $0) == "settings-model-option-unattributed"
            }
            let checked = HostedAccessibility.elements(in: window).filter { $0.accessibilityTraits.contains(.selected) }
            XCTAssertEqual(checked.count, 1)
            XCTAssertTrue(checked[0].accessibilityLabel?.contains(plain.displayName) == true)
        }
    }

    func testEffortChoicePageShowsConfigurationRefusal() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(ComposerModelPickerSheet(client: fixture.client,
            selectedModelID: "fixture-model", selectedModelProviderID: "fixture-provider", selectedModelOptionID: "fixture-model",
            onSelect: { _ in }, keepsSelectionOpen: true, showsReasoningControl: true,
            selectedReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"],
            errorMessage: "Fixture effort refused"))
        let effort = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-model-effort" }
        XCTAssertTrue(HostedAccessibility.activate(effort))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-effort-high" }
        let visible = await awaitCondition { HostedAccessibility.element(in: window, label: "Fixture effort refused") != nil }
        XCTAssertTrue(visible, "A refused choice must show its existing error on the choice page")
    }

    func testTaskPickerClearsToServerDefaultWithoutComposerOptions() async throws {
        let fixture = try FixtureApp(for: self)
        var draft = CronJobEditorDraft(model: "fixture-model", provider: "fixture-provider", modelOptionID: "fixture-model")
        try await renderHostedPage("task-model-picker") {
            ComposerModelPickerSheet(client: fixture.client, selectedModelID: "fixture-model",
                selectedModelProviderID: "fixture-provider", selectedModelOptionID: "fixture-model",
                onSelect: { draft.applyModelSelection($0) }, requiresCustomProviderID: false,
                onClear: { draft.applyModelSelection(nil) })
        } inspect: { window, _ in
            let clear = try await requireElement(in: window, label: "Server Default")
            XCTAssertNil(HostedAccessibility.element(in: window, label: "Options"))
            XCTAssertNil(HostedAccessibility.element(in: window, identifier: "composer-model-effort"))
            XCTAssertTrue(HostedAccessibility.activate(clear))
            XCTAssertNil(draft.trimmedModel)
            XCTAssertNil(draft.trimmedProvider)
        }
    }

    private func catalog(_ groups: [ModelCatalogGroup], favorites: [ModelCatalogOption] = []) async throws -> SettingsModelPickerViewModel {
        func wire(_ model: ModelCatalogOption) -> [String: Any] {
            var row: [String: Any] = ["id": model.id, "label": model.displayName, "favorite": model.isFavorite, "preferences_editable": model.preferencesEditable]
            row["provider_id"] = model.providerID
            row["bare_id"] = model.bareID
            if let date = model.limitResetsAt { row["limit"] = ["resets_at": date.ISO8601Format()] }
            return row
        }
        let value: [String: Any] = ["profile": "synthetic", "preferences_supported": true, "favorites": [], "favorite_models": favorites.map(wire), "visible_favorite_models": favorites.map(wire),
            "groups": groups.map { group -> [String: Any] in
                var row: [String: Any] = ["provider": group.name, "model_count": group.models.count, "models": group.models.map(wire)]
                row["provider_id"] = group.providerID
                row["quota_level"] = group.quotaLevel?.rawValue
                if let date = group.accountLimitResetsAt { row["limit"] = ["scope": "account", "resets_at": date.ISO8601Format()] }
                if let availability = group.availability {
                    row["availability"] = ["status": availability.status ?? "", "authoritative": availability.authoritative ?? false, "unavailable_reason": availability.unavailableReason ?? ""]
                }
                return row
            }]
        let data = try JSONSerialization.data(withJSONObject: value)
        let client = makeClient { request in (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, data) }
        let state = SettingsModelPickerViewModel(client: client, favorites: .shared)
        await state.load()
        return state
    }
}
