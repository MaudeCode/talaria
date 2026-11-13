import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// TAL-935: the composer model picker shows the server's rate limits and quota levels (TAL-807) on the provider
/// headings and the cooling-down model rows.
@MainActor
final class ComposerModelPickerHostedTests: XCTestCase {
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
        let actions = try await hostedMenuActions("Select model", readyAction: "All Models...", in: window)
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(actions.first { $0.title == "All Models..." })))
        let heading = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Fixture Provider") == true
        }
        XCTAssertTrue(HostedAccessibility.activate(heading))
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

    func testPickerAndQuotaRowShowRecoveryAuthority() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let models = try decoder.decode(ModelsResponse.self, from: Data(#"{"availability":{"status":"stale","authoritative":false,"generation":"synthetic","unavailable_reason":"Provider data is temporarily unavailable. Showing last-confirmed data."},"default_model":"gpt-6.1-sol","groups":[{"provider":"OpenAI Codex","provider_id":"openai-codex","models":[{"id":"gpt-6.1-sol","label":"GPT-6.1 Sol"}]}]}"#.utf8))
        func picker(_ groups: [ModelCatalogGroup]) -> ComposerModelPickerSheet {
            ComposerModelPickerSheet(modelGroups: groups, selectedModelID: "gpt-6.1-sol", selectedModelProviderID: "openai-codex", selectedModelOptionID: "gpt-6.1-sol", favoriteModelKeys: [], recentModelKeys: [], onSelect: { _ in }, onToggleFavorite: { _ in }, onDeleteSavedCustom: { _ in })
        }
        let baseline = try hostWindow(picker([ModelCatalogGroup(id: "openai-codex", name: models.catalogGroups[0].name, providerID: "openai-codex", models: models.catalogGroups[0].models)]))
        let baselineHeading = try XCTUnwrap(HostedAccessibility.elements(in: baseline, labelContaining: "OpenAI Codex").last)
        HostedAccessibility.activate(baselineHeading)
        attachHostedScreenshot(baseline, name: "catalog-before")
        baseline.isHidden = true
        let window = try hostWindow(picker(models.catalogGroups))
        XCTAssertTrue(HostedAccessibility.labels(in: window).contains { $0.contains("Last-confirmed data") })
        let heading = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "Last-confirmed data").first)
        HostedAccessibility.activate(heading)
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

    func testPickerShowsRateLimitsAndQuotaLevelsFromTheCatalog() throws {
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
        let window = try hostWindow(
            ComposerModelPickerSheet(
                modelGroups: groups,
                selectedModelID: nil,
                selectedModelProviderID: nil,
                selectedModelOptionID: nil,
                favoriteModelKeys: [],
                recentModelKeys: [],
                onSelect: { _ in },
                onToggleFavorite: { _ in },
                onDeleteSavedCustom: { _ in }
            )
        )

        let accountTime = accountResetsAt.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        let headings = HostedAccessibility.labels(in: window)
        XCTAssertTrue(headings.contains { $0.contains("OpenAI Codex") && $0.contains("Limited until \(accountTime)") }, "Labels: \(headings)")
        XCTAssertTrue(headings.contains { $0.contains("Anthropic") && $0.contains("Low quota") }, "Labels: \(headings)")
        XCTAssertTrue(headings.contains { $0.contains("Nous") && $0.contains("Quota nearly out") }, "Labels: \(headings)")

        let anthropic = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "Anthropic").first)
        HostedAccessibility.activate(anthropic)
        let modelTime = modelResetsAt.formatted(date: .omitted, time: .shortened)
        XCTAssertTrue(waitUntil {
            HostedAccessibility.labels(in: window).contains { $0.contains("Claude Opus 4.1") && $0.contains("Limited until \(modelTime)") }
        }, "Labels: \(HostedAccessibility.labels(in: window))")
        XCTAssertFalse(
            HostedAccessibility.labels(in: window).contains { $0.contains("Claude Sonnet 4.5") && $0.contains("Limited until") },
            "A model without a limit shows one"
        )
    }
}
