#if DEBUG
import Foundation

@MainActor
struct UITestFixtureEnvironment {
    nonisolated static let launchArgument = "--ui-test-fixture"
    nonisolated static let relayConnectedArgument = "--ui-test-relay-connected"
    nonisolated static let serverURL = URL(string: "https://ui-test.talaria.invalid")!

    let authManager: AuthManager
    let client: APIClient
    let draftStore: ChatDraftStore

    static func make() -> UITestFixtureEnvironment {
        let keychain = UITestFixtureKeychainStore(serverURL: serverURL)
        let defaultsName = "dev.kil.talaria.ui-test-fixture"
        let defaults = UserDefaults(suiteName: defaultsName)!
        defaults.removePersistentDomain(forName: defaultsName)
        let client = APIClient(baseURL: serverURL)
        try? TalariaRelayConfigurationStore.clear()
        if ProcessInfo.processInfo.arguments.contains(relayConnectedArgument),
           let publisherID = TalariaRelayClient.originURL(serverURL)?.absoluteString {
            try? TalariaRelayConfigurationStore.save(TalariaRelayCredentials(
                baseURL: URL(string: "https://relay.ui-test.invalid")!,
                deviceID: "device-ui-fixture",
                userID: "user-ui-fixture",
                appleUserID: "apple-ui-fixture",
                sessionToken: "session-ui-fixture",
                expiresAt: .distantFuture,
                pairedPublisherIDs: [publisherID]
            ))
        }

        return UITestFixtureEnvironment(
            authManager: AuthManager(
                keychain: keychain,
                clientFactory: { _ in client },
                probeClientFactory: { _, _ in client },
                headerStore: CustomHeaderStore(),
                cookieStorage: URLSessionConfiguration.ephemeral.httpCookieStorage!,
                profileEntityCache: ProfileEntityCache(defaults: nil),
                serverRegistry: ServerRegistry(keychain: keychain, identityDefaults: defaults)
            ),
            client: client,
            draftStore: ChatDraftStore(persistence: UITestFixtureDraftPersistence())
        )
    }
}

private final class UITestFixtureKeychainStore: KeychainStoring {
    private let lock = NSLock()
    private var values: [String: String]

    init(serverURL: URL) {
        values = [KeychainStore.Key.serverURL.rawValue: serverURL.absoluteString]
    }

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        lock.withLock { values[key.rawValue] = value }
    }

    func load(_ key: KeychainStore.Key) throws -> String? {
        lock.withLock { values[key.rawValue] }
    }

    func delete(_ key: KeychainStore.Key) throws {
        _ = lock.withLock { values.removeValue(forKey: key.rawValue) }
    }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        lock.withLock { values[KeychainStore.scopedKey(key, scope: scope)] = value }
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        lock.withLock { values[KeychainStore.scopedKey(key, scope: scope)] }
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        _ = lock.withLock { values.removeValue(forKey: KeychainStore.scopedKey(key, scope: scope)) }
    }
}

private actor UITestFixtureDraftPersistence: ChatDraftPersisting {
    private var drafts: [ChatDraftKey: ChatDraft] = [:]

    func load() async -> [ChatDraftKey: ChatDraft] { drafts }

    func write(_ drafts: [ChatDraftKey: ChatDraft]) async throws {
        self.drafts = drafts
    }
}

final class UITestFixtureURLProtocol: URLProtocol {
    static let sessionID = "ui-fixture-session"
    static let sessionTitle = "UI Fixture Session"

    static func configure(_ configuration: URLSessionConfiguration) {
        guard ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.launchArgument) else { return }
        configuration.protocolClasses = [Self.self]
            + (configuration.protocolClasses ?? []).filter { $0 != Self.self }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == UITestFixtureEnvironment.serverURL.host
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        let isEventStream = url.path.hasSuffix("/stream")
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": isEventStream ? "text/event-stream" : "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseData(for: url))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func responseData(for url: URL) -> Data {
        switch url.path {
        case "/health":
            return json(["status": "ok"])
        case "/api/auth/status":
            return json(["auth_enabled": false, "logged_in": true])
        case "/api/sessions":
            return sessionsResponse()
        case "/api/sessions/search":
            return json(["sessions": [], "query": "", "count": 0])
        case "/api/session":
            return sessionResponse()
        case "/api/session/new":
            return json(["session": session(id: "ui-fixture-new-session", title: "New Fixture Chat")])
        case "/api/projects":
            return json(["projects": []])
        case "/api/profiles":
            return json([
                "profiles": [[
                    "name": "fixture-profile",
                    "display_name": "Fixture Profile",
                    "is_active": true,
                    "default_model": "fixture-model",
                    "provider": "fixture-provider"
                ]],
                "active": "fixture-profile",
                "single_profile_mode": false
            ])
        case "/api/providers":
            return json([
                "active_provider": "fixture-provider",
                "providers": [[
                    "id": "fixture-provider",
                    "display_name": "Fixture Provider",
                    "has_key": true,
                    "models": []
                ]]
            ])
        case "/api/provider/quotas":
            return providerQuotasResponse()
        case "/api/models":
            return json([
                "groups": [],
                "models": [["id": "fixture-model", "label": "Fixture Model"]],
                "default_model": "fixture-model",
                "active_provider": "fixture-provider"
            ])
        case "/api/workspaces":
            return json(["workspaces": [["path": "/fixture", "name": "Fixture Workspace"]]])
        case "/api/workspaces/suggest":
            return json(["suggestions": ["/fixture"], "prefix": "/fixture"])
        case "/api/commands":
            return json(["commands": []])
        case "/api/personalities":
            return json(["personalities": []])
        case "/api/skills":
            return json(["skills": []])
        case "/api/chat/stream", "/api/approval/stream", "/api/clarify/stream", "/api/kanban/events/stream":
            return Data("event: stream_end\ndata: {}\n\n".utf8)
        default:
            return json([:])
        }
    }

    private static func sessionsResponse() -> Data {
        let sessions: [[String: Any]] = (0..<18).map { index in
            session(
                id: index == 0 ? sessionID : "ui-fixture-session-\(index)",
                title: index == 0 ? sessionTitle : String(format: "Fixture Session %02d", index)
            )
        }
        return json(["sessions": sessions, "archived_count": 0])
    }

    private static func sessionResponse() -> Data {
        let messages: [[String: Any]] = (0..<48).map { index in
            [
                "role": index.isMultiple(of: 2) ? "user" : "assistant",
                "content": "Fixture message \(index + 1) contains deterministic transcript content for scrolling.",
                "_ts": 2_000_000_000 + index
            ]
        }
        var detail = session(id: sessionID, title: sessionTitle)
        detail["messages"] = messages
        return json(["session": detail])
    }

    private static func session(id: String, title: String) -> [String: Any] {
        [
            "session_id": id,
            "title": title,
            "message_count": 48,
            "last_message_at": 2_000_000_000,
            "workspace": "/fixture",
            "model": "fixture-model",
            "model_provider": "fixture-provider",
            "profile": "fixture-profile",
            "archived": false
        ]
    }

    private static func providerQuotasResponse() -> Data {
        json([
            "version": 1,
            "scope_id": "ui-fixture-scope",
            "profile_id": "ui-fixture-profile",
            "active_provider": "fixture-provider",
            "sources": [[
                "source_id": "ui-fixture-source",
                "provider_id": "fixture-provider",
                "provider_label": "Fixture Provider",
                "account_label": "Fixture Account",
                "is_active_provider": true,
                "supported": true,
                "status": "available",
                "windows": [[
                    "label": "Session",
                    "used_percent": 25,
                    "remaining_percent": 75,
                    "reset_at": "2030-01-01T00:00:00Z"
                ]]
            ]]
        ])
    }

    private static func json(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
#endif
