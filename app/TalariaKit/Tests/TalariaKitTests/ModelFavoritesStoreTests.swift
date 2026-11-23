import XCTest
@testable import TalariaKit

final class ModelFavoritesStoreTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = .ephemeral("ModelFavoritesStoreTests")
    }

    override func tearDown() {
        defaults = nil
        super.tearDown()
    }

    func testFavoritesDefaultStorageKeyLoadsTalariaValues() throws {
        let expected = [ModelFavoriteKey(modelID: "openai/gpt-5.5", providerID: "openai")]
        defaults.set(try JSONEncoder().encode(expected), forKey: "talaria.favoriteModels")

        XCTAssertEqual(ModelFavoritesStore(defaults: defaults).favoriteKeys, expected)
    }

    func testRecentsDefaultStorageKeyLoadsTalariaValues() throws {
        let expected = [ModelFavoriteKey(modelID: "openai/gpt-5.5", providerID: "openai")]
        defaults.set(try JSONEncoder().encode(expected), forKey: "talaria.recentModels")

        XCTAssertEqual(ModelRecentsStore(defaults: defaults).recentKeys, expected)
    }

    func testRecordRecentMovesModelToFrontAndLimitsResults() {
        let store = ModelRecentsStore(defaults: defaults, storageKey: "recents", limit: 3)
        let gpt = ModelCatalogOption(id: "gpt-5.5", displayName: "GPT-5.5", providerID: "openai")
        let claude = ModelCatalogOption(id: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", providerID: "anthropic")
        let gemini = ModelCatalogOption(id: "gemini-3-pro", displayName: "Gemini 3 Pro", providerID: "google")
        let local = ModelCatalogOption(id: "local-qwen", displayName: "Local Qwen", providerID: "local")

        _ = store.recordRecent(gpt)
        _ = store.recordRecent(claude)
        _ = store.recordRecent(gemini)
        _ = store.recordRecent(claude)
        let recentKeys = store.recordRecent(local)

        XCTAssertEqual(recentKeys, [local.favoriteKey, claude.favoriteKey, gemini.favoriteKey])
        XCTAssertEqual(store.recentKeys, recentKeys)
    }

    func testVisibleRecentOptionsSkipsFavoritesAndDropsModelsOutsideTheCatalog() {
        let gpt = ModelCatalogOption(id: "gpt-5.5", displayName: "GPT-5.5", providerID: "openai")
        let claude = ModelCatalogOption(id: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", providerID: "anthropic")
        let gemini = ModelCatalogOption(id: "gemini-3-pro", displayName: "Gemini 3 Pro", providerID: "google")
        let missing = ModelCatalogOption(id: "missing-model", displayName: "missing-model", providerID: "local")
        let groups = [
            ModelCatalogGroup(id: "openai", name: "OpenAI", providerID: "openai", models: [gpt]),
            ModelCatalogGroup(id: "anthropic", name: "Anthropic", providerID: "anthropic", models: [claude]),
            ModelCatalogGroup(id: "google", name: "Google", providerID: "google", models: [gemini])
        ]
        let recentKeys = [
            claude.favoriteKey,
            missing.favoriteKey,
            gpt.favoriteKey,
            gemini.favoriteKey
        ]

        let visibleOptions = ModelRecentsStore.visibleRecentOptions(
            in: groups,
            recentKeys: recentKeys,
            favoriteKeys: [gpt.favoriteKey]
        )

        XCTAssertEqual(visibleOptions, [claude, gemini],
            "The shared picker must not restore hidden or filtered-out rows from local recents")
    }
}
