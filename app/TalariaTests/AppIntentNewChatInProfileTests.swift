import XCTest
import AppIntents
import WidgetKit
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

    func testMediumBotChatWidgetEntryPreservesTheFourProfileLinksInSlotOrder() throws {
        let publisher = "https://widget.example.test/talaria"
        let profiles = try ["research", "default", "workspace", "coding"].map { name in
            let url = try XCTUnwrap(TalariaDeepLink.botChatURL(profileName: name, publisherID: publisher))
            return ProfileEntity(id: url.absoluteString, name: name, subtitle: nil)
        }
        let configuration = NewChatWidgetConfigurationIntent()
        configuration.botProfile = profiles[0]
        configuration.secondBotProfile = profiles[1]
        configuration.thirdBotProfile = profiles[2]
        configuration.fourthBotProfile = profiles[3]

        let entry = NewChatWidgetEntry(configuration: configuration, family: .systemMedium)
        let routes = entry.botLinks.compactMap(TalariaDeepLink.botChat(from:))
        XCTAssertEqual(routes.map(\.profileName), profiles.map(\.name))
        XCTAssertEqual(routes.map(\.publisherID), Array(repeating: publisher, count: profiles.count))
    }

    @MainActor
    func testIntentQueuesTheProfileDeepLink() async throws {
        let intent = NewChatInProfileIntent()
        intent.profile = ProfileEntity(id: "dev", name: "dev", subtitle: nil)
        _ = try await intent.perform()
        XCTAssertEqual(
            AppIntentRouter.shared.pendingDeepLink,
            TalariaDeepLink.newChatInProfileURL(profileName: "dev")
        )
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
        XCTAssertEqual(loaded.last?.name, "dev")
        XCTAssertNil(loaded.last?.subtitle)
    }

    func testBotChatPickerKeepsTheServerProfileListWhenACanonicalChatIsMissing() throws {
        let cache = ProfileEntityCache(defaults: .ephemeral("bot-chat-widget-profiles"))
        let publisher = "https://widget.example.test/talaria"
        let profiles = try APIClient.responseDecoder().decode([ProfileSummary].self, from: Data("""
            [
              {"name":"workspace","display_name":"Workspace","canonical_session":null},
              {"name":"research","display_name":"Research","canonical_session":{"session_id":"root","tip_session_id":"tip"}}
            ]
            """.utf8))
        cache.save(profiles, publisherID: publisher)

        let routes = cache.loadBotChatEntities().compactMap { URL(string: $0.id).flatMap(TalariaDeepLink.botChat(from:)) }
        XCTAssertEqual(routes.map(\.profileName), ["workspace", "research"])
        XCTAssertEqual(cache.loadBotChatProfiles(publisherID: publisher).map(\.id), ["workspace", "research"])
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

    /// A `ProfileEntityCache` backed by a throwaway `UserDefaults` suite so tests never touch
    /// the real app-group cache.
    private func makeIsolatedCache() -> (ProfileEntityCache, String, UserDefaults) {
        let suite = "test.profileentitycache.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (ProfileEntityCache(defaults: defaults), suite, defaults)
    }
}
