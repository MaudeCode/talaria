import XCTest
import AppIntents
@testable import Talaria
@testable import TalariaKit

// The members of AppIntentNewChatInProfileTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class AppIntentNewChatInProfileTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        await MainActor.run { AppIntentRouter.shared.pendingDeepLink = nil }
    }

    override func tearDown() async throws {
        await MainActor.run { AppIntentRouter.shared.pendingDeepLink = nil }
        try await super.tearDown()
    }

    func testIntentOpensAppWhenRun() {
        XCTAssertTrue(NewChatInProfileIntent.openAppWhenRun)
    }

    @MainActor
    func testIntentQueuesTheProfileDeepLink() async throws {
        var intent = NewChatInProfileIntent()
        intent.profile = ProfileEntity(id: "dev", name: "dev", subtitle: nil)
        _ = try await intent.perform()
        XCTAssertEqual(
            AppIntentRouter.shared.pendingDeepLink,
            TalariaDeepLink.newChatInProfileURL(profileName: "dev")
        )
    }

    func testProfileEntityFromSummaryUsesNameAndModelProviderSubtitle() throws {
        let summary = ProfileSummary(
            name: "dev", path: nil, isDefault: false, isActive: false,
            gatewayRunning: nil, model: "kimi", provider: "opencode", hasEnv: nil, skillCount: nil
        )
        let entity = try XCTUnwrap(ProfileEntity(summary))
        XCTAssertEqual(entity.id, "dev")
        XCTAssertEqual(entity.name, "dev")
        XCTAssertEqual(entity.subtitle, "kimi · opencode")
    }

    func testDefaultProfileEntityUsesLocalizedDisplayName() throws {
        let summary = ProfileSummary(
            name: "default", path: nil, isDefault: true, isActive: true,
            gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil
        )
        let entity = try XCTUnwrap(ProfileEntity(summary))
        XCTAssertEqual(entity.id, "default")
        XCTAssertEqual(entity.name, String(localized: "Default"))
        XCTAssertNil(entity.subtitle)
    }

    func testProfileEntityIsNilForBlankName() {
        let summary = ProfileSummary(
            name: "   ", path: nil, isDefault: nil, isActive: nil,
            gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil
        )
        XCTAssertNil(ProfileEntity(summary))
    }

    func testCacheRoundTripsProfilesAsEntities() throws {
        let (cache, suite, defaults) = makeIsolatedCache()
        defer { defaults.removePersistentDomain(forName: suite) }

        cache.save([
            ProfileSummary(name: "default", path: nil, isDefault: true, isActive: true,
                           gatewayRunning: nil, model: "gpt", provider: "openai", hasEnv: nil, skillCount: nil),
            ProfileSummary(name: "dev", path: nil, isDefault: false, isActive: false,
                           gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil)
        ])

        let loaded = cache.loadEntities()
        XCTAssertEqual(loaded.map(\.id), ["default", "dev"])
        XCTAssertEqual(loaded.first?.name, String(localized: "Default"))
        XCTAssertEqual(loaded.first?.subtitle, "gpt · openai")
    }

    func testCacheSkipsUnnamedProfiles() throws {
        let (cache, suite, defaults) = makeIsolatedCache()
        defer { defaults.removePersistentDomain(forName: suite) }

        cache.save([
            ProfileSummary(name: "  ", path: nil, isDefault: nil, isActive: nil,
                           gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil),
            ProfileSummary(name: "dev", path: nil, isDefault: nil, isActive: nil,
                           gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil)
        ])

        XCTAssertEqual(cache.loadEntities().map(\.id), ["dev"])
    }

    func testSavingEmptyProfilesClearsTheCache() throws {
        let (cache, suite, defaults) = makeIsolatedCache()
        defer { defaults.removePersistentDomain(forName: suite) }

        cache.save([
            ProfileSummary(name: "dev", path: nil, isDefault: nil, isActive: nil,
                           gatewayRunning: nil, model: nil, provider: nil, hasEnv: nil, skillCount: nil)
        ])
        XCTAssertFalse(cache.loadEntities().isEmpty)

        cache.save([])
        XCTAssertTrue(cache.loadEntities().isEmpty)
    }

    /// A `ProfileEntityCache` backed by a throwaway `UserDefaults` suite so tests never touch
    /// the real app-group cache.
    private func makeIsolatedCache() -> (ProfileEntityCache, String, UserDefaults) {
        let suite = "test.profileentitycache.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (ProfileEntityCache(defaults: defaults), suite, defaults)
    }
}
