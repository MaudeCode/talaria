import XCTest
@testable import Talaria

final class APIClientSessionListTests: APIClientTestCase {
    func testSessionStatusDecodesPinnedAgentRunningShape() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/session/status")
            XCTAssertEqual(request.httpMethod, "GET")
            return apiTestJSONResponse(
                #"{"session_id":"contract-session","agent_running":true}"#,
                for: request
            )
        }

        let response = try await client.sessionStatus(id: "contract-session")

        XCTAssertEqual(response.sessionId, "contract-session")
        XCTAssertEqual(response.isStreaming, true)
    }

    func testLiveUpstreamContractResponsesDecodeWhenSupplied() throws {
        let manifestData: Data
        if let path = ProcessInfo.processInfo.environment["TALARIA_LIVE_CONTRACT_RESPONSES"] {
            // PR CI supplies the Linux probe's digest-checked fixture at test time
            // (TEST_RUNNER_ prefix), so the build never waits for the probe.
            manifestData = try Data(contentsOf: URL(fileURLWithPath: path))
        } else {
            let encoded = Bundle(for: APIClientSessionListTests.self)
                .object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
#if TALARIA_LIVE_CONTRACT
            guard let encoded, encoded.hasPrefix("base64:")
            else {
                XCTFail("The contract runner did not provide live upstream responses")
                return
            }
#else
            guard let encoded, encoded.hasPrefix("base64:")
            else {
                throw XCTSkip("No live upstream responses were supplied")
            }
#endif
            manifestData = try XCTUnwrap(Data(base64Encoded: String(encoded.dropFirst(7))))
        }
        let manifest = try XCTUnwrap(
            JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
        )
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        func decode<T: Decodable>(_ type: T.Type, fixture: String) throws {
            let object = try XCTUnwrap(manifest[fixture], "Missing live fixture: \(fixture)")
            let data = try JSONSerialization.data(withJSONObject: object)
            _ = try decoder.decode(type, from: data)
        }

        try decode(HealthResponse.self, fixture: "health")
        try decode(AuthStatusResponse.self, fixture: "auth_status")
        try decode(SessionsResponse.self, fixture: "sessions")
        try decode(ProjectsResponse.self, fixture: "projects")
        try decode(WorkspacesResponse.self, fixture: "workspaces")
        try decode(WorkspaceSuggestionsResponse.self, fixture: "workspace_suggestions")
        try decode(ModelsResponse.self, fixture: "models")
        try decode(ProvidersResponse.self, fixture: "providers")
        try decode(SettingsResponse.self, fixture: "settings")
        try decode(ReasoningStatusResponse.self, fixture: "reasoning")
        try decode(ProfilesResponse.self, fixture: "profiles")
        try decode(PersonalitiesResponse.self, fixture: "personalities")
        try decode(CommandsResponse.self, fixture: "commands")
        try decode(MemoryResponse.self, fixture: "memory")
        try decode(SessionMutationResponse.self, fixture: "session_new")
        try decode(SessionResponse.self, fixture: "session_detail")
        try decode(SessionStatusResponse.self, fixture: "session_status")
        try decode(DirectoryListResponse.self, fixture: "directory_list")
        try decode(FileResponse.self, fixture: "file")
        try decode(SessionMutationResponse.self, fixture: "session_mutation")
        try decode(SessionBranchResponse.self, fixture: "session_branch")
        try decode(ChatStreamStatusResponse.self, fixture: "stream_status")

        let clarificationData = try JSONSerialization.data(withJSONObject: XCTUnwrap(manifest["clarification_pending"]))
        let clarification = try decoder.decode(ClarificationPendingResponse.self, from: clarificationData)
        let steps = try XCTUnwrap(clarification.pending?.steps)
        XCTAssertEqual(steps.count, 1)
        let step = try XCTUnwrap(steps.first)
        XCTAssertEqual(step.qid, "q0")
        XCTAssertEqual(step.question, "Which checks?")
        XCTAssertEqual(step.choices, ["unit", "ui"])
        XCTAssertTrue(step.multiSelect)
    }

    func testSessionsDecodesSnakeCaseResponse() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            XCTAssertEqual(request.httpMethod, "GET")
            // The default fetch must stay parameterless so the main list request
            // (and its server-side ordering) is unchanged (issue #17).
            XCTAssertNil(request.url?.query)

            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "session_id": "abc123",
                  "title": "Planning",
                  "message_count": 7,
                  "last_message_at": 1770000000,
                  "pinned": true,
                  "archived": false
                }
              ],
              "cli_count": 2,
              "archived_count": 8,
              "server_time": 1770000001,
              "server_tz": "-0400"
            }
            """, for: request)
        }

        let response = try await client.sessions()

        XCTAssertEqual(response.sessions?.first?.sessionId, "abc123")
        XCTAssertEqual(response.sessions?.first?.title, "Planning")
        XCTAssertEqual(response.sessions?.first?.messageCount, 7)
        XCTAssertEqual(response.sessions?.first?.lastMessageAt, 1_770_000_000)
        XCTAssertEqual(response.sessions?.first?.pinned, true)
        XCTAssertEqual(response.cliCount, 2)
        XCTAssertEqual(response.archivedCount, 8)
    }

    func testSessionsDecodesDelegationAndReadOnlyMetadataTolerantly() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            XCTAssertEqual(request.httpMethod, "GET")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "session_id": "subagent-child",
                  "source_tag": "subagent",
                  "raw_source": "subagent",
                  "session_source": "other",
                  "source_label": "Subagent",
                  "parent_session_id": "parent-1",
                  "relationship_type": "child_session",
                  "read_only": true
                },
                {
                  "session_id": "subagent-without-flag",
                  "source_tag": "subagent"
                },
                {
                  "session_id": "older-server-row"
                }
              ]
            }
            """, for: request)
        }

        let response = try await client.sessions()
        let sessions = try XCTUnwrap(response.sessions)
        let child = try XCTUnwrap(sessions.first)

        XCTAssertEqual(child.sourceTag, "subagent")
        XCTAssertEqual(child.rawSource, "subagent")
        XCTAssertEqual(child.sessionSource, "other")
        XCTAssertEqual(child.sourceLabel, "Subagent")
        XCTAssertEqual(child.parentSessionId, "parent-1")
        XCTAssertEqual(child.relationshipType, "child_session")
        XCTAssertEqual(child.readOnly, true)
        XCTAssertTrue(child.isDelegatedSubagentSession)
        XCTAssertTrue(child.isSessionReadOnly)

        // TAL-312: read-only comes from the server's `read_only` alone, never from source markers.
        XCTAssertTrue(sessions[1].isDelegatedSubagentSession)
        XCTAssertFalse(sessions[1].isSessionReadOnly)
        XCTAssertNil(sessions[2].sourceTag)
        XCTAssertNil(sessions[2].parentSessionId)
        XCTAssertNil(sessions[2].readOnly)
        XCTAssertFalse(sessions[2].isDelegatedSubagentSession)
        XCTAssertFalse(sessions[2].isSessionReadOnly)
    }

    func testSessionsIncludeArchivedBuildsQueryAndDecodesMergedRows() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/sessions")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query, ["include_archived": "1", "archived_limit": "50"])

            // include_archived=1 merges archived rows into the visible list;
            // each row carries an `archived` flag (upstream routes.py @312d3fab).
            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "session_id": "visible-1",
                  "title": "Visible",
                  "archived": false
                },
                {
                  "session_id": "archived-1",
                  "title": "Old research",
                  "archived": true
                }
              ]
            }
            """, for: request)
        }

        let response = try await client.sessions(includeArchived: true, archivedLimit: 50)

        XCTAssertEqual(response.sessions?.compactMap(\.sessionId), ["visible-1", "archived-1"])
        XCTAssertEqual(response.sessions?.last?.archived, true)
        // Tolerant decoding: an older server that omits archived_count still decodes.
        XCTAssertNil(response.archivedCount)
    }

    func testSessionsVisibilityOverridesStayOnTheReadRequest() async throws {
        let visibility = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: false,
            showsWebhook: true,
            showsClaudeCode: false
        )
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/sessions")

            let components = URLComponents(
                url: try XCTUnwrap(request.url),
                resolvingAgainstBaseURL: false
            )
            let query = Dictionary(
                uniqueKeysWithValues: (components?.queryItems ?? []).map {
                    ($0.name, $0.value ?? "")
                }
            )
            XCTAssertEqual(
                query,
                [
                    "show_cli_sessions": "0",
                    "show_claude_code_sessions": "0",
                    "show_cron_sessions": "1",
                    "show_webhook_sessions": "1"
                ]
            )

            return apiTestJSONResponse(#"{"sessions":[]}"#, for: request)
        }

        _ = try await client.sessions(visibility: visibility)
    }

    func testSessionSearchRequestBuildsExpectedQueryAndDecodesContentMatch() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/sessions/search")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["q"], "billing plan")
            XCTAssertEqual(query["content"], "1")
            XCTAssertEqual(query["depth"], "5")

            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "session_id": "content-123",
                  "title": "Planning",
                  "match_type": "content",
                  "match_preview": "the [REDACTED] billing plan for caf\\u00e9",
                  "unexpected": "ignored"
                }
              ],
              "query": "billing plan",
              "count": 1
            }
            """, for: request)
        }

        let response = try await client.searchSessions(query: "billing plan", content: true, depth: 5)

        XCTAssertEqual(response.query, "billing plan")
        XCTAssertEqual(response.count, 1)
        XCTAssertEqual(response.sessions?.first?.sessionId, "content-123")
        XCTAssertEqual(response.sessions?.first?.matchType, "content")
        XCTAssertEqual(response.sessions?.first?.matchPreview, "the [REDACTED] billing plan for café")
    }

    func testSessionSearchDecodesEmptyQueryResponseWithoutQueryOrCount() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/sessions/search")
            XCTAssertEqual(request.httpMethod, "GET")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["q"], "")
            XCTAssertEqual(query["content"], "1")
            XCTAssertEqual(query["depth"], "5")

            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "session_id": "abc123",
                  "title": "Planning"
                }
              ]
            }
            """, for: request)
        }

        let response = try await client.searchSessions(query: "", content: true, depth: 5)

        XCTAssertEqual(response.sessions?.first?.sessionId, "abc123")
        XCTAssertNil(response.sessions?.first?.matchType)
        XCTAssertNil(response.sessions?.first?.matchPreview)
        XCTAssertNil(response.query)
        XCTAssertNil(response.count)
    }
    /// One malformed row used to fail the whole array, so a single CLI or
    /// subagent session with a drifted field emptied the entire list and
    /// pull-to-refresh could never bring it back. Rows are decoded
    /// independently and each field is lossy, matching `SessionDetail` and
    /// `ProjectSummary`, which already worked this way.
    func testSessionListSurvivesOneMalformedRow() async throws {
        let client = makeClient { request in
            apiTestJSONResponse("""
            {"sessions": [
              {"session_id": "good-1", "title": "Fine", "message_count": 3},
              {"session_id": "drifted", "title": "Odd", "message_count": "12", "created_at": "not-a-number"},
              {"session_id": 42},
              {"title": "Missing server identity"},
              {"session_id": "   ", "title": "Blank server identity"},
              {"session_id": "good-2", "title": "Also fine"}
            ]}
            """, for: request)
        }

        let response = try await client.sessions()
        let ids = (response.sessions ?? []).compactMap(\.sessionId)

        XCTAssertEqual(response.sessions?.count, 6)
        XCTAssertEqual(ids, ["good-1", "drifted", "42", "   ", "good-2"])
        XCTAssertNil(response.sessions?[3].sessionId)
        XCTAssertEqual(response.sessions?[4].sessionId, "   ")
        XCTAssertEqual(
            response.sessions?.first(where: { $0.sessionId == "drifted" })?.messageCount,
            12,
            "A numeric string still reads as a count."
        )
        XCTAssertEqual(
            response.sessions?.first(where: { $0.sessionId == "42" })?.sessionId,
            "42",
            "A numeric id is coerced rather than dropped."
        )
    }
}
