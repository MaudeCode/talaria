import XCTest
@testable import Talaria

final class ContractReadinessTests: APIClientTestCase {
    func testEndpointContractMatrixMatchesPinnedUpstreamPathsAndQueries() throws {
        let contracts: [EndpointContract] = [
            .init(name: "health", endpoint: .health, path: "/health"),
            .init(name: "auth status", endpoint: .authStatus, path: "/api/auth/status"),
            .init(name: "login", endpoint: .login, path: "/api/auth/login"),
            .init(name: "logout", endpoint: .logout, path: "/api/auth/logout"),
            .init(name: "native OIDC start", endpoint: .nativeOIDCStart, path: "/api/auth/oidc/native/start"),
            .init(name: "native OIDC exchange", endpoint: .nativeOIDCExchange, path: "/api/auth/oidc/native/exchange"),
            .init(name: "native OIDC cancel", endpoint: .nativeOIDCCancel, path: "/api/auth/oidc/native/cancel"),
            .init(name: "sessions", endpoint: .sessions(), path: "/api/sessions"),
            .init(
                name: "sessions including archived",
                endpoint: .sessions(includeArchived: true, archivedLimit: 3),
                path: "/api/sessions",
                query: ["include_archived": "1", "archived_limit": "3"]
            ),
            .init(
                name: "sessions including archived without limit",
                endpoint: .sessions(includeArchived: true),
                path: "/api/sessions",
                query: ["include_archived": "1"]
            ),
            .init(
                name: "session search",
                endpoint: .sessionsSearch(query: "billing plan", content: true, depth: 5),
                path: "/api/sessions/search",
                query: ["q": "billing plan", "content": "1", "depth": "5"]
            ),
            .init(
                name: "session detail",
                endpoint: .session(id: "session-123", includeMessages: true, messageLimit: 50, messageBefore: 100),
                path: "/api/session",
                query: ["session_id": "session-123", "messages": "1", "msg_limit": "50", "msg_before": "100"]
            ),
            .init(
                name: "session detail cold load expand_renderable",
                endpoint: .session(id: "session-123", includeMessages: true, messageLimit: 50, messageBefore: nil, expandRenderable: true),
                path: "/api/session",
                query: ["session_id": "session-123", "messages": "1", "msg_limit": "50", "expand_renderable": "1"]
            ),
            .init(
                name: "session status",
                endpoint: .sessionStatus(id: "session-123"),
                path: "/api/session/status",
                query: ["session_id": "session-123"]
            ),
            .init(name: "new session", endpoint: .newSession, path: "/api/session/new"),
            .init(name: "rename session", endpoint: .renameSession, path: "/api/session/rename"),
            .init(name: "delete session", endpoint: .deleteSession, path: "/api/session/delete"),
            .init(name: "pin session", endpoint: .pinSession, path: "/api/session/pin"),
            .init(name: "archive session", endpoint: .archiveSession, path: "/api/session/archive"),
            .init(name: "branch session", endpoint: .branchSession, path: "/api/session/branch"),
            .init(name: "import session", endpoint: .importSession, path: "/api/session/import_cli"),
            .init(name: "compress session", endpoint: .compressSession, path: "/api/session/compress"),
            .init(name: "undo session", endpoint: .undoSession, path: "/api/session/undo"),
            .init(name: "retry session", endpoint: .retrySession, path: "/api/session/retry"),
            .init(name: "truncate session", endpoint: .truncateSession, path: "/api/session/truncate"),
            .init(name: "update session", endpoint: .updateSession, path: "/api/session/update"),
            .init(name: "move session", endpoint: .moveSession, path: "/api/session/move"),
            .init(
                name: "session yolo",
                endpoint: .sessionYolo(sessionID: "session-123"),
                path: "/api/session/yolo",
                query: ["session_id": "session-123"]
            ),
            .init(name: "projects", endpoint: .projects, path: "/api/projects"),
            .init(name: "create project", endpoint: .createProject, path: "/api/projects/create"),
            .init(name: "rename project", endpoint: .renameProject, path: "/api/projects/rename"),
            .init(name: "delete project", endpoint: .deleteProject, path: "/api/projects/delete"),
            .init(name: "chat start", endpoint: .chatStart, path: "/api/chat/start"),
            .init(
                name: "chat stream",
                endpoint: .chatStream(streamID: "stream-123"),
                path: "/api/chat/stream",
                query: ["stream_id": "stream-123"]
            ),
            .init(
                name: "chat cancel",
                endpoint: .chatCancel(streamID: "stream-123"),
                path: "/api/chat/cancel",
                query: ["stream_id": "stream-123"]
            ),
            .init(
                name: "chat stream status",
                endpoint: .chatStreamStatus(streamID: "stream-123"),
                path: "/api/chat/stream/status",
                query: ["stream_id": "stream-123"]
            ),
            .init(name: "chat steer", endpoint: .chatSteer, path: "/api/chat/steer"),
            .init(name: "goal", endpoint: .submitGoal, path: "/api/goal"),
            .init(
                name: "approval pending",
                endpoint: .approvalPending(sessionID: "session-123"),
                path: "/api/approval/pending",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "approval stream",
                endpoint: .approvalStream(sessionID: "session-123"),
                path: "/api/approval/stream",
                query: ["session_id": "session-123"]
            ),
            .init(name: "approval respond", endpoint: .approvalRespond, path: "/api/approval/respond"),
            .init(
                name: "clarification pending",
                endpoint: .clarifyPending(sessionID: "session-123"),
                path: "/api/clarify/pending",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "clarification stream",
                endpoint: .clarifyStream(sessionID: "session-123"),
                path: "/api/clarify/stream",
                query: ["session_id": "session-123"]
            ),
            .init(name: "clarification respond", endpoint: .clarifyRespond, path: "/api/clarify/respond"),
            .init(name: "btw", endpoint: .btw, path: "/api/btw"),
            .init(name: "background", endpoint: .background, path: "/api/background"),
            .init(
                name: "background status",
                endpoint: .backgroundStatus(sessionID: "session-123"),
                path: "/api/background/status",
                query: ["session_id": "session-123"]
            ),
            .init(name: "workspaces", endpoint: .workspaces, path: "/api/workspaces"),
            .init(
                name: "workspace suggestions",
                endpoint: .workspaceSuggestions(prefix: "/Users/uzair"),
                path: "/api/workspaces/suggest",
                query: ["prefix": "/Users/uzair"]
            ),
            .init(name: "workspace add", endpoint: .workspaceAdd, path: "/api/workspaces/add"),
            .init(name: "workspace remove", endpoint: .workspaceRemove, path: "/api/workspaces/remove"),
            .init(name: "workspace rename", endpoint: .workspaceRename, path: "/api/workspaces/rename"),
            .init(name: "workspace reorder", endpoint: .workspaceReorder, path: "/api/workspaces/reorder"),
            .init(
                name: "directory list root",
                endpoint: .directoryList(sessionID: "session-123", path: nil),
                path: "/api/list",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "directory list nested",
                endpoint: .directoryList(sessionID: "session-123", path: "Sources/App.swift"),
                path: "/api/list",
                query: ["session_id": "session-123", "path": "Sources/App.swift"]
            ),
            .init(
                name: "file",
                endpoint: .file(sessionID: "session-123", path: "Sources/App.swift"),
                path: "/api/file",
                query: ["session_id": "session-123", "path": "Sources/App.swift"]
            ),
            .init(
                name: "raw file",
                endpoint: .rawFile(sessionID: "session-123", path: "Assets/icon.png"),
                path: "/api/file/raw",
                query: ["session_id": "session-123", "path": "Assets/icon.png"]
            ),
            .init(
                name: "media",
                endpoint: .media(sessionID: "session-123", path: "Assets/icon.png"),
                path: "/api/media",
                query: ["session_id": "session-123", "path": "Assets/icon.png"]
            ),
            .init(name: "models", endpoint: .models, path: "/api/models"),
            .init(name: "models live", endpoint: .modelsLive, path: "/api/models/live"),
            .init(name: "commands", endpoint: .commands, path: "/api/commands"),
            .init(name: "default model", endpoint: .defaultModel, path: "/api/default-model"),
            .init(name: "reasoning read", endpoint: .reasoning(), path: "/api/reasoning"),
            .init(
                name: "reasoning read scoped to model",
                endpoint: .reasoning(model: "gpt-5.4", provider: "openai"),
                path: "/api/reasoning",
                query: ["model": "gpt-5.4", "provider": "openai"]
            ),
            .init(name: "reasoning save", endpoint: .reasoning(), path: "/api/reasoning"),
            .init(name: "personalities", endpoint: .personalities, path: "/api/personalities"),
            .init(name: "set personality", endpoint: .setPersonality, path: "/api/personality/set"),
            .init(name: "profiles", endpoint: .profiles, path: "/api/profiles"),
            .init(name: "switch profile", endpoint: .switchProfile, path: "/api/profile/switch"),
            .init(name: "create profile", endpoint: .createProfile, path: "/api/profile/create"),
            .init(name: "providers", endpoint: .providers, path: "/api/providers"),
            .init(
                name: "provider quotas targeted refresh",
                endpoint: .providerQuotas(sourceID: "qsrc_123", refresh: true),
                path: "/api/provider/quotas",
                query: ["source": "qsrc_123", "refresh": "1"]
            ),
            .init(
                name: "legacy provider quota refresh",
                endpoint: .providerQuota(refresh: true),
                path: "/api/provider/quota",
                query: ["refresh": "1"]
            ),
            .init(name: "settings", endpoint: .settings, path: "/api/settings"),
            .init(
                name: "insights",
                endpoint: .insights(days: 30),
                path: "/api/insights",
                query: ["days": "30"]
            ),
            .init(name: "crons", endpoint: .crons, path: "/api/crons"),
            .init(name: "cron create", endpoint: .cronCreate, path: "/api/crons/create"),
            .init(name: "cron update", endpoint: .cronUpdate, path: "/api/crons/update"),
            .init(name: "cron delete", endpoint: .cronDelete, path: "/api/crons/delete"),
            .init(name: "cron run", endpoint: .cronRun, path: "/api/crons/run"),
            .init(name: "cron pause", endpoint: .cronPause, path: "/api/crons/pause"),
            .init(name: "cron resume", endpoint: .cronResume, path: "/api/crons/resume"),
            .init(name: "cron status all", endpoint: .cronStatus(jobID: nil), path: "/api/crons/status"),
            .init(
                name: "cron status job",
                endpoint: .cronStatus(jobID: "job-123"),
                path: "/api/crons/status",
                query: ["job_id": "job-123"]
            ),
            .init(
                name: "cron output",
                endpoint: .cronOutput(jobID: "job-123", limit: 5),
                path: "/api/crons/output",
                query: ["job_id": "job-123", "limit": "5"]
            ),
            .init(
                name: "cron history",
                endpoint: .cronHistory(jobID: "job-123", offset: 40, limit: 20),
                path: "/api/crons/history",
                query: ["job_id": "job-123", "offset": "40", "limit": "20"]
            ),
            .init(
                name: "cron run detail",
                endpoint: .cronRunDetail(jobID: "job-123", filename: "2026-05-04_10-00-00.md"),
                path: "/api/crons/run",
                query: ["job_id": "job-123", "filename": "2026-05-04_10-00-00.md"]
            ),
            .init(
                name: "cron delivery options",
                endpoint: .cronDeliveryOptions,
                path: "/api/crons/delivery-options"
            ),
            .init(name: "memory", endpoint: .memory, path: "/api/memory"),
            .init(name: "memory write", endpoint: .memoryWrite, path: "/api/memory/write"),
            .init(name: "skills", endpoint: .skills, path: "/api/skills"),
            .init(
                name: "skill content",
                endpoint: .skillContent(name: "swiftui-ui-patterns", file: nil),
                path: "/api/skills/content",
                query: ["name": "swiftui-ui-patterns"]
            ),
            .init(
                name: "skill linked file",
                endpoint: .skillContent(name: "swiftui-ui-patterns", file: "references/navigation.md"),
                path: "/api/skills/content",
                query: ["name": "swiftui-ui-patterns", "file": "references/navigation.md"]
            ),
            .init(name: "upload", endpoint: .upload, path: "/api/upload")
        ]

        let baseURL = URL(string: "https://example.test")!

        for contract in contracts {
            let url = contract.endpoint.url(relativeTo: baseURL)
            let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false), contract.name)

            XCTAssertEqual(components.path, contract.path, contract.name)
            XCTAssertEqual(queryDictionary(from: components), contract.query, contract.name)
        }
    }

    func testJSONPostRequestsOmitBrowserCSRFHeaders() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/session/pin")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "session": {
                "session_id": "abc123",
                "pinned": true
              }
            }
            """, for: request)
        }

        let response = try await client.pinSession(id: "abc123", pinned: true)

        XCTAssertEqual(response.ok, true)
    }

    func testMultipartPostRequestsOmitBrowserCSRFHeaders() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/upload")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
            XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data") == true)

            return apiTestJSONResponse("""
            {
              "filename": "contract.txt",
              "path": "/tmp/workspace/contract.txt",
              "size": 8,
              "mime": "text/plain",
              "is_image": false
            }
            """, for: request)
        }

        let response = try await client.uploadFile(sessionID: "abc123", data: Data("contract".utf8), filename: "contract.txt")

        XCTAssertEqual(response.filename, "contract.txt")
    }

    private func queryDictionary(from components: URLComponents) -> [String: String] {
        Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }
}

/// `Endpoint` owns the URL only: the HTTP method is chosen per call site in
/// `APIClient`, so it is asserted where each call's request is intercepted
/// rather than restated here (TAL-122).
private struct EndpointContract {
    let name: String
    let endpoint: Endpoint
    let path: String
    let query: [String: String]

    init(name: String, endpoint: Endpoint, path: String, query: [String: String] = [:]) {
        self.name = name
        self.endpoint = endpoint
        self.path = path
        self.query = query
    }
}

final class SharedContractTests: XCTestCase {
    func testAppAdvertisesCanonicalContractVersions() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let versions = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/versions.json"))) as? [String: Any])
        let appWeb = try XCTUnwrap(versions["appWeb"] as? [String: Any])
        let appRelay = try XCTUnwrap(versions["appRelay"] as? [String: Any])
        let scene = try XCTUnwrap(versions["activityScene"] as? [String: Any])
        let identity = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(AppConfig.clientIdentity.utf8)) as? [String: Any])
        let supported = try XCTUnwrap(identity["contracts"] as? [String: Any])
        XCTAssertEqual(supported["appWeb"] as? [Int], [try XCTUnwrap(appWeb["fixtureVersion"] as? Int)])
        XCTAssertEqual(supported["appRelay"] as? [Int], [try XCTUnwrap(appRelay["aggregateSchemaVersion"] as? Int)])
        XCTAssertEqual(supported["activityScene"] as? [String], [try XCTUnwrap(scene["version"] as? String)])
    }

    private func fixture(_ name: String) throws -> Data {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/\(name).json"))
    }

    private func session(_ handler: @escaping MockURLProtocol.Handler) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(handler)]
        return URLSession(configuration: configuration)
    }

    func testSharedWebSessionAndActivityScene() async throws {
        let data = try fixture("web-session")
        let session = session { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        defer { session.invalidateAndCancel() }
        let client = APIClient(baseURL: URL(string: "https://contract.example")!, session: session)
        let response = try await client.session(id: "contract-session")
        let message = try XCTUnwrap(response.session?.messages?.first)
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
        XCTAssertEqual(timeline.rows.map(\.kind), ["prose", "tools", "prose"])
        XCTAssertEqual(timeline.toolCalls.map(\.id), ["contract-call"])
        XCTAssertEqual(CompletedAssistantTurn(rows: timeline.rows)?.finalAnswer, "Contract answer.")
    }

    func testSharedWebSessionStatesItsTranscriptCursor() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func session(_ key: String) throws -> SessionDetail {
            try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(object[key])))
        }
        // A run without a journal: the transcript holds its persisted rows and states no cursor.
        XCTAssertNil(try session("session").transcriptSeq)
        // A journaled run: the transcript ends at the running turn's prompt, and replay resumes after the cursor.
        let journaled = try session("journaled_session")
        XCTAssertEqual(journaled.transcriptSeq, TranscriptSeq(streamId: "contract-run-h", seq: 0))
        XCTAssertEqual(journaled.messages?.last?.role, "user")
    }

    func testSharedWebSessionRendersServerBuiltTurnScenes() async throws {
        let data = try fixture("web-session")
        let session = session { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        defer { session.invalidateAndCancel() }
        let client = APIClient(baseURL: URL(string: "https://contract.example")!, session: session)
        let response = try await client.session(id: "contract-session")
        let messages = try XCTUnwrap(response.session?.messages)
        // A release checks this App against every retained Web. A Web from before server-built scenes stamps no turn
        // ids; against it every reply still yields its answer, from its stored scene or as plain text.
        guard messages.contains(where: { $0.turnId != nil }) else {
            let replies = messages.filter { $0.role == "assistant" }
            XCTAssertFalse(replies.isEmpty)
            for reply in replies {
                let answer = AssistantActivityTimeline.authoritativeScene(message: reply)
                    .flatMap { CompletedAssistantTurn(rows: $0.rows)?.finalAnswer } ?? reply.content
                XCTAssertFalse((answer ?? "").isEmpty, "\(reply.messageId ?? "reply") renders no answer")
            }
            return
        }
        func turn(_ messageID: String) throws -> CompletedAssistantTurn {
            let message = try XCTUnwrap(messages.first { $0.messageId == messageID })
            let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
            return try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))
        }

        // Codex commentary is prose under Worked, before its tool; the answer renders below Worked.
        let codex = try turn("contract-run-c-2")
        XCTAssertEqual(codex.workRows.map(\.kind), ["reasoning", "prose", "tools"])
        XCTAssertEqual(codex.finalAnswer, "The service uses port 8080.")
        XCTAssertEqual(try turn("contract-run-d-2").finalAnswer, "Tool budget exhausted; here is the saved explanation.")
        // Earlier prose alone still folds under Worked; only the server's final answer stays visible.
        let twoReplies = try turn("contract-run-a-2")
        XCTAssertEqual(twoReplies.workRows.map(\.kind), ["prose"])
        XCTAssertEqual(twoReplies.finalAnswer, "Second reply in the same turn.")
        // A turn the server says has no answer never promotes its last prose.
        XCTAssertEqual(try turn("contract-run-e-1").finalAnswer, "")
        XCTAssertEqual(messages.first { $0.messageId == "contract-run-d-2" }?.activityScene?.expandedByDefault, true)
        XCTAssertEqual(messages.first { $0.messageId == "contract-run-c-2" }?.activityScene?.expandedByDefault, false)
        // The server's outcome decodes and renders in its localized wording; a completed turn shows none.
        func outcome(_ messageID: String) -> String? {
            AssistantTurnOutcome.label(for: messages.first { $0.messageId == messageID }?.activityScene?.terminalState)
        }
        XCTAssertEqual(outcome("contract-run-d-2"), "Tool limit reached")
        XCTAssertEqual(outcome("contract-run-e-1"), "No answer produced.")
        XCTAssertNil(outcome("contract-run-c-2"))
        // Persisted steers split the turn into phases whose lengths the server measured.
        let steered = try turn("contract-run-g-3")
        XCTAssertTrue(steered.hasSteering)
        XCTAssertEqual(steered.finalAnswer, "Both files read.")
        XCTAssertEqual(steered.phaseDurations(totalDuration: 12, finalPhaseDuration: 3), [5, 4, 3])
        XCTAssertNil(ChatViewModel.transcriptMessages(from: messages).first { $0.message.messageId == "contract-steer-1" })
        // The running turn has no scene: the live stream renders it.
        let running = try XCTUnwrap(messages.first { $0.messageId == "contract-run-f-1" })
        XCTAssertNil(AssistantActivityTimeline.authoritativeScene(message: running))
    }

    func testSharedWebSessionFlagsDriveStreamingAndReadOnly() throws {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("web-session")) as? [String: Any])
        // A Web from before server-validated flags (TAL-312) ships neither example; its session keeps the older shape.
        guard let stale = root["stale_stream_session"], let child = root["subagent_session"], let live = root["session"] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func summary(_ object: Any) throws -> SessionSummary {
            SessionSummary(from: try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: object)))
        }

        let running = try summary(live)
        XCTAssertEqual(running.isStreaming, true)
        XCTAssertTrue(SessionRowView.isActiveStreaming(running))
        XCTAssertFalse(running.isSessionReadOnly)
        XCTAssertFalse(SessionRowView.isActiveStreaming(try summary(stale)))
        XCTAssertTrue(try summary(child).isSessionReadOnly)
        XCTAssertEqual(running.canBranch, true)
        XCTAssertEqual(try summary(child).canBranch, false)
    }

    func testSharedRelaySnapshotAndRegistration() async throws {
        let snapshot = try fixture("relay-snapshot")
        let registration = try JSONSerialization.jsonObject(with: fixture("app-registration")) as! NSDictionary
        let session = session { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer contract-session-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            if request.httpMethod == "PUT" {
                let body = try XCTUnwrap(apiTestBodyData(from: request))
                XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? NSDictionary, registration)
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
            }
            XCTAssertEqual(request.url?.path, "/v1/activity-snapshot")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Device-Id"), "contract-device")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, snapshot)
        }
        defer { session.invalidateAndCancel() }
        let credentials = TalariaRelayCredentials(
            baseURL: URL(string: "https://relay.example")!, deviceID: "contract-device",
            userID: "contract-user", appleUserID: "contract-apple", sessionToken: "contract-session-token"
        )
        let client = TalariaRelayClient(credentials: credentials, session: session)
        let aggregate = try await client.snapshot()
        XCTAssertEqual(aggregate?.schemaVersion, 1)
        XCTAssertEqual(aggregate?.rows.first?.publisherId, "https://contract.example")
        XCTAssertEqual(aggregate?.rows.first?.sessionId, "contract-session")
        try await client.registerPerSession(
            activityID: "contract-activity", pushToken: "contract-activity-token",
            publisherID: "https://contract.example", sessionID: "contract-session", streamID: "contract-stream"
        )
    }
}
