import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// TAL-935: the composer model picker shows the server's rate limits and quota levels (TAL-807) on the provider
/// headings and the cooling-down model rows.
@MainActor
final class ComposerModelPickerHostedTests: XCTestCase {
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
