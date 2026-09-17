import SwiftUI
import XCTest
@testable import Talaria

final class ComposerModelProviderIconTests: XCTestCase {
    private let groups = [
        ModelCatalogGroup(
            id: "openai",
            name: "OpenAI",
            providerID: "openai",
            models: [ModelCatalogOption(id: "gpt-5.5", displayName: "GPT-5.5", providerID: "openai")]
        ),
        ModelCatalogGroup(
            id: "gemini",
            name: "Gemini",
            providerID: "gemini",
            models: [ModelCatalogOption(id: "@gemini:flash", displayName: "Flash", providerID: "gemini")]
        ),
    ]

    func testActiveControlResolvesKnownProviderThroughCatalog() throws {
        // A bare active-provider id names no provider itself; the catalog does.
        let icon = try XCTUnwrap(ComposerModelMenu.providerIcon(
            modelGroups: groups,
            selectedModelID: "gpt-5.5",
            selectedModelProviderID: nil
        ))
        XCTAssertEqual(icon.id, "openai")
        XCTAssertEqual(icon.label, "OpenAI")
        XCTAssertEqual(ProviderIconRegistry.assetName(providerID: icon.id), "ProviderIconOpenAI")

        let tagged = try XCTUnwrap(ComposerModelMenu.providerIcon(
            modelGroups: groups,
            selectedModelID: "@gemini:flash",
            selectedModelProviderID: nil
        ))
        XCTAssertEqual(tagged.id, "gemini")
    }

    func testActiveControlKeepsRegistryFallbackForUnknownProvider() throws {
        let icon = try XCTUnwrap(ComposerModelMenu.providerIcon(
            modelGroups: groups,
            selectedModelID: "private-model",
            selectedModelProviderID: "custom:private"
        ))
        XCTAssertEqual(icon.id, "custom:private")
        XCTAssertEqual(icon.label, "custom:private")
        let descriptor = ProviderIconRegistry.descriptor(providerID: icon.id, label: icon.label)
        XCTAssertNil(descriptor.assetName)
        XCTAssertEqual(descriptor.fallbackInitials, "CP")
    }

    func testActiveControlShowsNoIconWithoutProviderIdentity() {
        XCTAssertNil(ComposerModelMenu.providerIcon(
            modelGroups: groups,
            selectedModelID: "mystery",
            selectedModelProviderID: nil
        ))
        XCTAssertNil(ComposerModelMenu.providerIcon(
            modelGroups: groups,
            selectedModelID: nil,
            selectedModelProviderID: "openai"
        ))
    }

    func testMixedProviderSectionSubtitlesDistinguishSameNamedModels() {
        let duplicates = [
            ModelCatalogOption(id: "flash", displayName: "Flash", providerID: "openai"),
            ModelCatalogOption(id: "flash", displayName: "Flash", providerID: "gemini"),
            ModelCatalogOption(id: "flash", displayName: "Flash", providerID: "custom:private"),
        ]
        XCTAssertEqual(
            ComposerModelMenu.providerSubtitles(for: duplicates, in: groups),
            ["OpenAI", "Gemini", "custom:private"]
        )

        let single = Array(duplicates.prefix(1)) + [
            ModelCatalogOption(id: "gpt-5.5", displayName: "GPT-5.5", providerID: "openai")
        ]
        XCTAssertEqual(ComposerModelMenu.providerSubtitles(for: single, in: groups), [nil, nil])
    }

    @MainActor
    func testControlLabelRendersProviderGlyphBeforeTitle() throws {
        func width(providerIcon: (id: String, label: String)?) throws -> Int {
            let renderer = ImageRenderer(content: ComposerMetaControlLabel(
                title: "GPT-5.5",
                systemImage: nil,
                providerIcon: providerIcon,
                maxWidth: 132,
                color: .primary,
                controlFont: .footnote,
                chevronFont: .caption2
            ).fixedSize())
            renderer.scale = 1
            return try XCTUnwrap(renderer.cgImage, "ImageRenderer produced no image").width
        }

        let plain = try width(providerIcon: nil)
        XCTAssertGreaterThan(try width(providerIcon: ("openai", "OpenAI")), plain)
        XCTAssertGreaterThan(try width(providerIcon: ("custom:private", "Private")), plain)
    }
}
