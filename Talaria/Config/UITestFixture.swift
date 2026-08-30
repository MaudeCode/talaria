#if DEBUG
import Foundation

@MainActor
struct UITestFixtureEnvironment {
    nonisolated static let launchArgument = "--ui-test-fixture"
    nonisolated static let relayConnectedArgument = "--ui-test-relay-connected"
    nonisolated static let serverURL = URL(string: "https://ui-test.talaria.invalid")!
    nonisolated static var relayCredentials: TalariaRelayCredentials {
        TalariaRelayCredentials(
            baseURL: URL(string: "https://relay.ui-test.invalid")!,
            deviceID: "device-ui-fixture",
            userID: "user-ui-fixture",
            appleUserID: "apple-ui-fixture",
            sessionToken: "session-ui-fixture",
            expiresAt: .distantFuture,
            pairedPublisherIDs: [
                TalariaRelayClient.originURL(serverURL)!.absoluteString,
                "https://removed.ui-test.invalid"
            ]
        )
    }

    let authManager: AuthManager
    let client: APIClient
    let draftStore: ChatDraftStore

    static func make() -> UITestFixtureEnvironment {
        let chatScenario = UITestChatScenario.current
        UserDefaults.standard.set(
            StreamingSendBehavior.steer.rawValue,
            forKey: StreamingSendBehavior.storageKey
        )
        UserDefaults.standard.set(chatScenario == nil, forKey: StreamedTextAnimationSettings.isEnabledKey)
        UserDefaults.standard.set(true, forKey: ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey)
        UserDefaults.standard.set(
            chatScenario != nil,
            forKey: ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey
        )

        let keychain = UITestFixtureKeychainStore(serverURL: serverURL)
        let defaultsName = "dev.kil.talaria.ui-test-fixture"
        let defaults = UserDefaults(suiteName: defaultsName)!
        defaults.removePersistentDomain(forName: defaultsName)
        let client = APIClient(baseURL: serverURL)
        return UITestFixtureEnvironment(
            authManager: AuthManager(
                keychain: keychain,
                clientFactory: { _ in client },
                probeClientFactory: { _, _, _ in client },
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

private enum UITestChatScenario: String, CaseIterable {
    case full = "--ui-test-chat-full"
    case controls = "--ui-test-chat-controls"
    case error = "--ui-test-chat-error"
    case reconnect = "--ui-test-chat-reconnect"

    static var current: Self? {
        let arguments = ProcessInfo.processInfo.arguments
        return allCases.first { arguments.contains($0.rawValue) }
    }
}

private final class UITestChatFixtureState: @unchecked Sendable {
    static let shared = UITestChatFixtureState()

    private let condition = NSCondition()
    private var started = false
    private var settled = false
    private var approvalAnswered = false
    private var clarificationAnswered = false
    private var steerID: String?
    private var cancelled = false
    private var streamConnectionCount = 0

    func startChat() {
        condition.lock()
        started = true
        condition.broadcast()
        condition.unlock()
    }

    func settle() {
        condition.lock()
        settled = true
        condition.broadcast()
        condition.unlock()
    }

    func answerApproval() {
        condition.lock()
        approvalAnswered = true
        condition.broadcast()
        condition.unlock()
    }

    func answerClarification() {
        condition.lock()
        clarificationAnswered = true
        condition.broadcast()
        condition.unlock()
    }

    func acceptSteer(id: String?) {
        condition.lock()
        steerID = id
        condition.broadcast()
        condition.unlock()
    }

    func cancel() {
        condition.lock()
        cancelled = true
        settled = true
        condition.broadcast()
        condition.unlock()
    }

    func nextStreamConnection() -> Int {
        condition.lock()
        defer { condition.unlock() }
        streamConnectionCount += 1
        return streamConnectionCount
    }

    func snapshot() -> (
        started: Bool,
        settled: Bool,
        approvalAnswered: Bool,
        clarificationAnswered: Bool,
        steerID: String?,
        cancelled: Bool
    ) {
        condition.lock()
        defer { condition.unlock() }
        return (started, settled, approvalAnswered, clarificationAnswered, steerID, cancelled)
    }

    func wait(until predicate: @escaping (UITestChatFixtureState) -> Bool, stopped: () -> Bool) {
        condition.lock()
        while !predicate(self), !stopped() {
            condition.wait()
        }
        condition.unlock()
    }

    func wakeWaiters() {
        condition.lock()
        condition.broadcast()
        condition.unlock()
    }

    fileprivate var approvalWasAnswered: Bool { approvalAnswered }
    fileprivate var clarificationWasAnswered: Bool { clarificationAnswered }
    fileprivate var acceptedSteerID: String? { steerID }
    fileprivate var wasCancelled: Bool { cancelled }
}

final class UITestFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    static let sessionID = "ui-fixture-session"
    static let sessionTitle = "UI Fixture Session"
    private static let chatStreamID = "ui-fixture-stream"
    private static let chatState = UITestChatFixtureState.shared
    private let lifecycleLock = NSLock()
    private var stopped = false

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

        if UITestChatScenario.current != nil, url.path == "/api/chat/stream" {
            startScriptedChatStream(url: url)
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
        if UITestChatScenario.current != nil,
           url.path == "/api/approval/stream" || url.path == "/api/clarify/stream" {
            client?.urlProtocol(self, didLoad: Data(": fixture heartbeat\n\n".utf8))
            return
        }
        client?.urlProtocol(self, didLoad: Self.responseData(for: request))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        lifecycleLock.withLock { stopped = true }
        Self.chatState.wakeWaiters()
    }

    private static func responseData(for request: URLRequest) -> Data {
        guard let url = request.url else { return json([:]) }
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
            return UITestChatScenario.current == nil ? sessionResponse() : chatSessionResponse()
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
        case "/api/chat/start":
            chatState.startChat()
            return json(["stream_id": chatStreamID, "session_id": sessionID])
        case "/api/chat/cancel":
            chatState.cancel()
            return json(["ok": true, "cancelled": true, "stream_id": chatStreamID])
        case "/api/chat/stream/status":
            return json([
                "active": !chatState.snapshot().settled,
                "stream_id": chatStreamID,
                "replay_available": false
            ])
        case "/api/chat/steer":
            let steerID = requestJSON(request)["steer_id"] as? String
            chatState.acceptSteer(id: steerID)
            return json([
                "accepted": true,
                "stream_id": chatStreamID,
                "steer_id": steerID ?? "ui-fixture-steer"
            ])
        case "/api/approval/respond":
            chatState.answerApproval()
            return json(["ok": true, "choice": "once"])
        case "/api/approval/pending":
            return json(["pending_count": 0])
        case "/api/clarify/respond":
            chatState.answerClarification()
            return json(["ok": true, "response": "Use the deterministic path"])
        case "/api/clarify/pending":
            return json(["pending_count": 0])
        case "/api/session/yolo":
            return json(["ok": true, "yolo_enabled": false])
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

    private static func chatSessionResponse() -> Data {
        let state = chatState.snapshot()
        var detail = session(
            id: sessionID,
            title: state.settled && UITestChatScenario.current == .full
                ? "Deterministic Stream Complete"
                : sessionTitle
        )
        var messages: [[String: Any]] = []

        if state.started {
            messages.append([
                "role": "user",
                "content": "Run the deterministic fixture",
                "message_id": "ui-fixture-user",
                "_ts": 2_000_000_100
            ])
        }

        if state.settled, UITestChatScenario.current == .full {
            messages.append([
                "role": "assistant",
                "content": "Fixture opening. Fixture progress. Fixture finished.",
                "message_id": "ui-fixture-assistant",
                "_ts": 2_000_000_101,
                "_anchor_activity_scene": [
                    "version": "activity_scene_v1",
                    "final_answer": "Fixture finished.",
                    "activity_rows": [
                        ["row_id": "prose-1", "order_index": 0, "role": "prose", "text": "Fixture opening."],
                        [
                            "row_id": "thinking-1",
                            "order_index": 1,
                            "role": "thinking",
                            "thinking": ["text": "Inspect the fixture.", "titles": ["Inspecting fixture"]]
                        ],
                        ["row_id": "prose-2", "order_index": 2, "role": "prose", "text": "Fixture progress."],
                        [
                            "row_id": "tool-1",
                            "order_index": 3,
                            "role": "tool",
                            "status": "completed",
                            "tool": [
                                "id": "ui-fixture-tool",
                                "name": "fixture_tool",
                                "done": true,
                                "snippet": "fixture result"
                            ]
                        ],
                        ["row_id": "prose-3", "order_index": 4, "role": "prose", "text": "Fixture finished."]
                    ]
                ]
            ])
        } else if state.started, UITestChatScenario.current == .reconnect {
            messages.append([
                "role": "assistant",
                "content": "Before reconnect.",
                "message_id": "ui-fixture-assistant",
                "_ts": 2_000_000_101
            ])
        }

        detail["messages"] = messages
        detail["message_count"] = messages.count
        detail["active_stream_id"] = state.started && !state.settled ? chatStreamID : NSNull()
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

    private static func requestJSON(_ request: URLRequest) -> [String: Any] {
        guard let body = request.httpBody,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return [:] }
        return object
    }

    private func startScriptedChatStream(url: URL) {
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

        let connection = Self.chatState.nextStreamConnection()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.runChatScript(connection: connection)
        }
    }

    private func runChatScript(connection: Int) {
        guard let scenario = UITestChatScenario.current else { return }
        switch scenario {
        case .full:
            send(events: [
                ("token", ["text": "Fixture opening."]),
                ("reasoning", ["text": "Inspect the fixture.", "titles": ["Inspecting fixture"]]),
                ("token", ["text": " Fixture progress."]),
                ("tool", [
                    "event_type": "tool.started",
                    "name": "fixture_tool",
                    "preview": "fixture input",
                    "args": ["target": "synthetic"],
                    "tid": "ui-fixture-tool"
                ]),
                ("approval", [
                    "approval_id": "ui-fixture-approval",
                    "command": "fixture-tool --synthetic",
                    "description": "Allow the deterministic fixture to continue."
                ])
            ])
            wait { $0.approvalWasAnswered }
            guard !isStopped else { return }
            send(events: [
                ("tool_complete", [
                    "event_type": "tool.completed",
                    "name": "fixture_tool",
                    "preview": "fixture result",
                    "duration": 0.1,
                    "tid": "ui-fixture-tool"
                ]),
                ("token", ["text": " Fixture finished."]),
                ("clarify", [
                    "clarify_id": "ui-fixture-clarify",
                    "question": "Which deterministic path should continue?",
                    "choices_offered": ["Use the deterministic path"],
                    "session_id": Self.sessionID,
                    "kind": "clarify"
                ])
            ])
            wait { $0.clarificationWasAnswered }
            guard !isStopped else { return }
            Self.chatState.settle()
            send(events: [
                ("title", ["session_id": Self.sessionID, "title": "Deterministic Stream Complete"]),
                ("metering", [
                    "session_id": Self.sessionID,
                    "tokens_per_second": 12.5,
                    "tps_available": true,
                    "estimated": false
                ]),
                ("done", [:]),
                ("stream_end", [:])
            ])
            finish()
        case .controls:
            send(events: [("token", ["text": "Waiting for control input."])])
            wait { $0.acceptedSteerID != nil || $0.wasCancelled }
            guard !isStopped else { return }
            if let steerID = Self.chatState.snapshot().steerID {
                send(events: [("steer_consumed", [
                    "session_id": Self.sessionID,
                    "stream_id": Self.chatStreamID,
                    "steer_id": steerID,
                    "text": "Keep the fixture concise"
                ])])
            }
            wait { $0.wasCancelled }
            guard !isStopped else { return }
            send(events: [("cancel", [:])])
            finish()
        case .error:
            send(events: [
                ("token", ["text": "Partial fixture response."]),
                ("error", ["message": "Synthetic fixture failure"])
            ])
            Self.chatState.settle()
            finish()
        case .reconnect:
            if connection == 1 {
                send(events: [("token", ["text": "Before reconnect."])])
                fail(with: URLError(.networkConnectionLost))
                return
            }
            Self.chatState.settle()
            send(events: [
                ("token", ["text": " After reconnect."]),
                ("done", [:]),
                ("stream_end", [:])
            ])
            finish()
        }
    }

    private func wait(until predicate: @escaping (UITestChatFixtureState) -> Bool) {
        Self.chatState.wait(until: predicate, stopped: { [weak self] in self?.isStopped != false })
    }

    private var isStopped: Bool {
        lifecycleLock.withLock { stopped }
    }

    private func send(events: [(String, [String: Any])]) {
        guard !isStopped else { return }
        let data = events.reduce(into: Data()) { result, event in
            let payload = Self.json(event.1)
            result.append(Data("event: \(event.0)\ndata: ".utf8))
            result.append(payload)
            result.append(Data("\n\n".utf8))
        }
        client?.urlProtocol(self, didLoad: data)
    }

    private func finish() {
        guard !isStopped else { return }
        client?.urlProtocolDidFinishLoading(self)
    }

    private func fail(with error: Error) {
        guard !isStopped else { return }
        client?.urlProtocol(self, didFailWithError: error)
    }
}
#endif
