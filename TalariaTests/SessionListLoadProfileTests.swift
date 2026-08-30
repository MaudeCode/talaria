import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria


@MainActor
extension SessionListMutationTests {
    @MainActor
    func testLoadFallsBackToCachedSessionsForNetworkTimeout() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        let otherServerURL = try XCTUnwrap(URL(string: "https://other.example.test"))
        try CacheStore.cacheSessions(
            [
                SessionSummary(
                    sessionId: "cached-project-one",
                    title: "Cached project one",
                    archived: false,
                    projectId: "project-1",
                    profile: "work"
                ),
                SessionSummary(
                    sessionId: "cached-project-two",
                    title: "Cached project two",
                    archived: false,
                    projectId: "project-2",
                    profile: "work"
                ),
                SessionSummary(
                    sessionId: "cached-subagent",
                    title: "Cached delegated work",
                    archived: false,
                    projectId: "project-1",
                    profile: "work",
                    sourceTag: "subagent",
                    readOnly: true
                )
            ],
            serverURL: serverURL,
            in: context
        )
        try CacheStore.cacheSessions(
            [
                SessionSummary(sessionId: "other-server", title: "Other server", archived: false)
            ],
            serverURL: otherServerURL,
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            throw URLError(.timedOut)
        }

        await viewModel.load(modelContext: context)

        XCTAssertEqual(
            Set(viewModel.sessions.compactMap(\.sessionId)),
            Set(["cached-project-one", "cached-project-two", "cached-subagent"])
        )
        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: "project-1",
                automatedVisibility: AutomatedSessionVisibility(showsCron: true, showsCli: true)
            ).compactMap(\.sessionId),
            ["cached-project-one"]
        )
        XCTAssertEqual(
            Set(viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: "project-1",
                automatedVisibility: .showAll
            ).compactMap(\.sessionId)),
            Set(["cached-project-one", "cached-subagent"])
        )
        XCTAssertTrue(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testHiddenSessionKindsStayCachedAndCanAppearOffline() async throws {
        let context = try makeContext()
        var requestCount = 0
        let viewModel = try makeViewModel { request in
            requestCount += 1
            if requestCount > 1 {
                throw URLError(.notConnectedToInternet)
            }

            let components = URLComponents(
                url: try XCTUnwrap(request.url),
                resolvingAgainstBaseURL: false
            )
            let query = Dictionary(
                uniqueKeysWithValues: (components?.queryItems ?? []).map {
                    ($0.name, $0.value ?? "")
                }
            )
            let webhookRow = query["show_webhook_sessions"] == "1"
                ? #",{"session_id":"webhook-1","title":"Webhook","source_tag":"webhook"}"#
                : ""
            return apiTestJSONResponse(
                #"{"sessions":[{"session_id":"ordinary","title":"Ordinary"}\#(webhookRow)]}"#,
                for: request
            )
        }
        let hidesWebhook = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: true,
            showsWebhook: false
        )

        await viewModel.load(modelContext: context)
        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: nil,
                automatedVisibility: hidesWebhook
            ).compactMap(\.sessionId),
            ["ordinary"]
        )

        await viewModel.load(modelContext: context)

        XCTAssertTrue(viewModel.isViewingCachedData)
        XCTAssertEqual(
            Set(viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: nil,
                automatedVisibility: .showAll
            ).compactMap(\.sessionId)),
            Set(["ordinary", "webhook-1"])
        )
    }

    @MainActor
    func testLoadSurfacesNetworkTimeoutWhenCacheIsEmpty() async throws {
        let context = try makeContext()
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            throw URLError(.timedOut)
        }

        await viewModel.load(modelContext: context)

        XCTAssertTrue(viewModel.sessions.isEmpty)
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(
            viewModel.errorMessage,
            "The server did not respond in time. Check that the Mac is awake, hermes-webui is running, and the tunnel is connected."
        )
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testSessionLoadErrorStaysScopedWhenRemoteSearchFails() async throws {
        let context = try makeContext()
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                throw URLError(.timedOut)
            case "/api/sessions/search":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"boom"}"#.utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load(modelContext: context)
        let sessionLoadError = try XCTUnwrap(viewModel.sessionLoadError)
        XCTAssertTrue(CacheFallbackPolicy.shouldUseCache(for: sessionLoadError))
        XCTAssertEqual(
            viewModel.errorMessage,
            "The server did not respond in time. Check that the Mac is awake, hermes-webui is running, and the tunnel is connected."
        )

        await viewModel.searchSessions(query: "later", debounceNanoseconds: 0)

        XCTAssertFalse(CacheFallbackPolicy.shouldUseCache(for: try XCTUnwrap(viewModel.lastError)))
        XCTAssertTrue(CacheFallbackPolicy.shouldUseCache(for: try XCTUnwrap(viewModel.sessionLoadError)))
        XCTAssertEqual(
            viewModel.errorMessage,
            "The server did not respond in time. Check that the Mac is awake, hermes-webui is running, and the tunnel is connected."
        )
    }

    @MainActor
    func testLoadDoesNotReplaceSuccessfulOnlineSessionsWithStaleCache() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheSessions(
            [
                SessionSummary(sessionId: "stale-session", title: "Stale planning", archived: false)
            ],
            serverURL: serverURL,
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "session_id": "fresh-session",
                  "title": "Fresh planning",
                  "archived": false,
                  "project_id": "project-1",
                  "profile": "work"
                }
              ]
            }
            """, for: request)
        }

        await viewModel.load(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["fresh-session"])
        XCTAssertEqual(viewModel.sessions.first?.projectId, "project-1")
        XCTAssertEqual(viewModel.sessions.first?.profile, "work")
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertEqual(
            try CacheStore.cachedSessions(serverURL: serverURL, in: context).compactMap(\.sessionId),
            ["fresh-session"]
        )
    }

    @MainActor
    func testLoadFiltersEmptyUntitledPlaceholdersButKeepsRealUntitledRows() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {
                  "title": "Missing identity",
                  "message_count": 2,
                  "archived": false
                },
                {
                  "session_id": "   ",
                  "title": "Blank identity",
                  "message_count": 2,
                  "archived": false
                },
                {
                  "session_id": "empty-placeholder",
                  "title": "Untitled Session",
                  "message_count": 0,
                  "archived": false
                },
                {
                  "session_id": "empty-placeholder-missing-count",
                  "title": "Untitled Session",
                  "archived": false
                },
                {
                  "session_id": "contentful-untitled",
                  "title": "Untitled Session",
                  "message_count": 2,
                  "archived": false
                },
                {
                  "session_id": "recent-untitled",
                  "title": "Untitled",
                  "message_count": 0,
                  "last_message_at": 1770000000,
                  "archived": false
                },
                {
                  "session_id": "streaming-untitled",
                  "title": "Untitled",
                  "message_count": 0,
                  "active_stream_id": "stream-123",
                  "archived": false
                },
                {
                  "session_id": "pending-untitled",
                  "title": "Untitled",
                  "message_count": 0,
                  "has_pending_user_message": true,
                  "archived": false
                },
                {
                  "session_id": "worktree-untitled",
                  "title": "Untitled",
                  "message_count": 0,
                  "worktree_path": "/tmp/hermes-worktree",
                  "archived": false
                },
                {
                  "session_id": "named-empty",
                  "title": "Planning",
                  "message_count": 0,
                  "archived": false
                }
              ]
            }
            """, for: request)
        }

        await viewModel.load(modelContext: context)

        let expectedIDs = [
            "contentful-untitled",
            "streaming-untitled",
            "pending-untitled",
            "worktree-untitled",
            "named-empty"
        ]
        let loadedIDs = viewModel.sessions.compactMap(\.sessionId)
        XCTAssertEqual(Set(loadedIDs), Set(expectedIDs))
        XCTAssertEqual(loadedIDs.count, expectedIDs.count)

        let cachedIDs = try CacheStore.cachedSessions(serverURL: serverURL, in: context).compactMap(\.sessionId)
        XCTAssertEqual(Set(cachedIDs), Set(expectedIDs))
        XCTAssertEqual(cachedIDs.count, expectedIDs.count)
    }

    @MainActor
    func testLoadDoesNotUseCachedSessionsForRealServerError() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheSessions(
            [
                SessionSummary(sessionId: "cached-session", title: "Cached planning", archived: false)
            ],
            serverURL: serverURL,
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 500,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            return (try XCTUnwrap(response), Data(#"{"error":"boom"}"#.utf8))
        }

        await viewModel.load(modelContext: context)

        XCTAssertTrue(viewModel.sessions.isEmpty)
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(viewModel.errorMessage, "The Hermes server hit an internal error. Check the server logs, then try again.")
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testCreateSessionReturnsEmptyPlaceholderWithoutInsertingIntoSessionList() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/workspaces":
                return apiTestJSONResponse("""
                {
                  "workspaces": [
                    {"path": "/tmp/workspace", "name": "Workspace"}
                  ],
                  "last": "/tmp/workspace"
                }
                """, for: request)
            case "/api/session/new":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["workspace"] as? String, "/tmp/workspace")
                XCTAssertNil(body["model"] as? String)
                XCTAssertNil(body["model_provider"] as? String)
                XCTAssertNil(body["profile"] as? String)

                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "new-123",
                    "title": "Untitled Session",
                    "workspace": "/tmp/workspace",
                    "updated_at": 1770000000,
                    "last_message_at": 1770000000,
                    "archived": false
                  }
                }
                """, for: request)
            case "/api/sessions":
                XCTFail("New-chat creation should not block on a full session-list reload.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let created = await viewModel.createSession(modelContext: context)

        XCTAssertEqual(created?.sessionId, "new-123")
        XCTAssertTrue(viewModel.sessions.isEmpty)
        XCTAssertTrue(try CacheStore.cachedSessions(serverURL: serverURL, in: context).isEmpty)
        XCTAssertEqual(requestedPaths, ["/api/workspaces", "/api/session/new"])
        XCTAssertFalse(viewModel.isCreatingSession)
        XCTAssertNil(viewModel.actionErrorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testCreateSessionWithProviderUsesThatProvidersFirstCatalogModel() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/workspaces":
                return apiTestJSONResponse(
                    #"{"workspaces":[{"path":"/tmp/workspace"}],"last":"/tmp/workspace"}"#,
                    for: request
                )
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "groups": [
                    {
                      "provider_id": "openai-codex",
                      "models": [{"id": "gpt-5.6-sol", "name": "GPT 5.6 SOL"}]
                    },
                    {
                      "provider_id": "opencode-go",
                      "models": [{"id": "@opencode-go:kimi-k2.7-code", "name": "Kimi K2.7 Code"}]
                    }
                  ]
                }
                """, for: request)
            case "/api/session/new":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["model"] as? String, "@opencode-go:kimi-k2.7-code")
                XCTAssertEqual(body["model_provider"] as? String, "opencode-go")
                return apiTestJSONResponse(
                    #"{"session":{"session_id":"provider-session","model":"@opencode-go:kimi-k2.7-code","model_provider":"opencode-go"}}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let created = await viewModel.createSession(provider: "opencode-go")

        XCTAssertEqual(created?.sessionId, "provider-session")
        XCTAssertEqual(requestedPaths, ["/api/workspaces", "/api/models", "/api/session/new"])
    }

    @MainActor
    func testCreateSessionWithUnknownProviderFallsBackToServerDefault() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/workspaces":
                return apiTestJSONResponse(#"{"workspaces":[]}"#, for: request)
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "groups": [{
                    "provider_id": "openai-codex",
                    "models": [{"id": "gpt-5.6-sol"}]
                  }]
                }
                """, for: request)
            case "/api/session/new":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertNil(body["model"])
                XCTAssertNil(body["model_provider"])
                return apiTestJSONResponse(
                    #"{"session":{"session_id":"default-session","model":"gpt-5.6-sol","model_provider":"openai-codex"}}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let created = await viewModel.createSession(provider: "missing-provider")

        XCTAssertEqual(created?.sessionId, "default-session")
        XCTAssertEqual(requestedPaths, ["/api/workspaces", "/api/models", "/api/session/new"])
    }

    @MainActor
    func testCreateSessionKeepsWorktreeBackedUntitledSessionWithoutCounts() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/workspaces":
                return apiTestJSONResponse("""
                {
                  "workspaces": [
                    {"path": "/tmp/workspace", "name": "Workspace"}
                  ],
                  "last": "/tmp/workspace"
                }
                """, for: request)
            case "/api/session/new":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "worktree-new",
                    "title": "Untitled Session",
                    "workspace": "/tmp/workspace",
                    "worktree_path": "/tmp/hermes-worktree",
                    "archived": false
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let created = await viewModel.createSession(modelContext: context)

        XCTAssertEqual(created?.sessionId, "worktree-new")
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["worktree-new"])
        XCTAssertEqual(
            try CacheStore.cachedSessions(serverURL: serverURL, in: context).compactMap(\.sessionId),
            ["worktree-new"]
        )
    }

    @MainActor
    func testLoadActiveProfileUsesProfilesEndpointAndStoresCurrentProfile() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")

            switch request.url?.path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "profiles": [
                    {
                      "name": "default",
                      "is_default": true,
                      "model": "gpt-5"
                    },
                    {
                      "name": "work",
                      "is_active": true,
                      "model": "claude-sonnet-4-5",
                      "provider": "anthropic"
                    }
                  ]
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadActiveProfile()

        XCTAssertEqual(requestedPaths, ["/api/profiles"])
        XCTAssertEqual(viewModel.activeProfileName, "work")
        XCTAssertEqual(viewModel.activeProfileDisplayName, "work")
        XCTAssertEqual(viewModel.activeProfileModel, "claude-sonnet-4-5")
        XCTAssertEqual(viewModel.activeProfileProvider, "anthropic")
        XCTAssertEqual(viewModel.profileOptions.compactMap(\.normalizedName), ["default", "work"])
        XCTAssertFalse(viewModel.isSingleProfileMode)
        XCTAssertFalse(viewModel.isLoadingActiveProfile)
        XCTAssertNil(viewModel.activeProfileErrorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testLoadActiveProfileStoresSingleProfileMode() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "default",
                  "profiles": [
                    { "name": "default", "is_default": true, "is_active": true }
                  ],
                  "single_profile_mode": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadActiveProfile()

        XCTAssertTrue(viewModel.isSingleProfileMode)
        XCTAssertEqual(viewModel.activeProfileName, "default")
    }

    @MainActor
    func testLoadActiveProfileCanRefreshChangedProfile() async throws {
        var profileLoadCount = 0
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/profiles":
                profileLoadCount += 1

                if profileLoadCount == 1 {
                    return apiTestJSONResponse("""
                    {
                      "active": "default",
                      "profiles": [
                        {"name": "default", "is_active": true, "model": "gpt-5", "provider": "openai"},
                        {"name": "work", "model": "claude-sonnet-4-5", "provider": "anthropic"}
                      ]
                    }
                    """, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "profiles": [
                    {"name": "default", "model": "gpt-5", "provider": "openai"},
                    {"name": "work", "is_active": true, "model": "claude-sonnet-4-5", "provider": "anthropic"}
                  ]
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadActiveProfile()
        XCTAssertEqual(viewModel.activeProfileDisplayName, "Default")
        XCTAssertEqual(viewModel.activeProfileModel, "gpt-5")

        await viewModel.loadActiveProfile()
        XCTAssertEqual(profileLoadCount, 2)
        XCTAssertEqual(viewModel.activeProfileName, "work")
        XCTAssertEqual(viewModel.activeProfileDisplayName, "work")
        XCTAssertEqual(viewModel.activeProfileModel, "claude-sonnet-4-5")
        XCTAssertEqual(viewModel.activeProfileProvider, "anthropic")
        XCTAssertNil(viewModel.activeProfileErrorMessage)
    }

    @MainActor
    func testSwitchActiveProfileCallsServerAndUpdatesPickerState() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path ?? "nil"
            requestedPaths.append(path)

            switch path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "default",
                  "profiles": [
                    {"name": "default", "is_active": true, "model": "gpt-5", "provider": "openai"},
                    {"name": "work", "model": "claude-sonnet-4-5", "provider": "anthropic"}
                  ]
                }
                """, for: request)
            case "/api/profile/switch":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["name"] as? String, "work")
                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "default_model": "claude-sonnet-4-5",
                  "profiles": [
                    {"name": "default", "model": "gpt-5", "provider": "openai"},
                    {"name": "work", "is_active": true, "model": "claude-sonnet-4-5", "provider": "anthropic"}
                  ]
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(path)")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadActiveProfile()
        let workProfile = try XCTUnwrap(viewModel.profileOptions.first { $0.normalizedName == "work" })
        let didSwitch = await viewModel.switchActiveProfile(workProfile)

        XCTAssertTrue(didSwitch)
        XCTAssertEqual(requestedPaths, ["/api/profiles", "/api/profile/switch"])
        XCTAssertEqual(viewModel.activeProfileName, "work")
        XCTAssertEqual(viewModel.activeProfileDisplayName, "work")
        XCTAssertEqual(viewModel.activeProfileModel, "claude-sonnet-4-5")
        XCTAssertEqual(viewModel.activeProfileProvider, "anthropic")
        XCTAssertFalse(viewModel.isSwitchingActiveProfile)
        XCTAssertNil(viewModel.switchingActiveProfileName)
        XCTAssertNil(viewModel.activeProfileErrorMessage)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testSwitchActiveProfileFailureKeepsExistingProfileState() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "default",
                  "profiles": [
                    {"name": "default", "is_active": true, "model": "gpt-5", "provider": "openai"},
                    {"name": "work", "model": "claude-sonnet-4-5", "provider": "anthropic"}
                  ]
                }
                """, for: request)
            case "/api/profile/switch":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"switch failed"}"#.utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadActiveProfile()
        let workProfile = try XCTUnwrap(viewModel.profileOptions.first { $0.normalizedName == "work" })
        let didSwitch = await viewModel.switchActiveProfile(workProfile)

        XCTAssertFalse(didSwitch)
        XCTAssertEqual(viewModel.activeProfileName, "default")
        XCTAssertEqual(viewModel.activeProfileDisplayName, "Default")
        XCTAssertEqual(viewModel.activeProfileModel, "gpt-5")
        XCTAssertFalse(viewModel.isSwitchingActiveProfile)
        XCTAssertNil(viewModel.switchingActiveProfileName)
        XCTAssertNotNil(viewModel.activeProfileErrorMessage)
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testLoadActiveProfileFailureDoesNotOverwriteSessionListState() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse(self.sessionListJSON(forLoadCount: 1), for: request)
            case "/api/profiles":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"profile failed"}"#.utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        await viewModel.loadActiveProfile()

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["session-abc"])
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertFalse(viewModel.isLoadingActiveProfile)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.activeProfileErrorMessage)
        XCTAssertNil(viewModel.activeProfileName)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testInactiveActiveStreamStatusReloadsSessionsToClearStreamingIndicator() async throws {
        var loadCount = 0
        var requestPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path ?? "nil"
            requestPaths.append(path)

            switch path {
            case "/api/sessions":
                loadCount += 1
                let activeStreamIDField = loadCount == 1 ? #","active_stream_id":"stream-123""# : ""
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {
                      "session_id": "session-streaming",
                      "title": "Streaming work",
                      "archived": false\(activeStreamIDField)
                    }
                  ]
                }
                """, for: request)
            case "/api/chat/stream/status":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let streamID = components?.queryItems?.first { $0.name == "stream_id" }?.value
                XCTAssertEqual(streamID, "stream-123")
                return apiTestJSONResponse(
                    #"{"active":false,"stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(path)")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        XCTAssertEqual(viewModel.sessions.first?.activeStreamId, "stream-123")

        let refreshResult = await viewModel.refreshActiveSessionStatesIfNeeded(streamIDs: ["stream-123"])

        XCTAssertEqual(refreshResult, .reloaded)
        XCTAssertNil(viewModel.sessions.first?.activeStreamId)
        XCTAssertEqual(requestPaths, ["/api/sessions", "/api/chat/stream/status", "/api/sessions"])
    }

    @MainActor
    func testActiveStreamStatusDoesNotReloadSessionsWhileStillActive() async throws {
        var loadCount = 0
        var statusCount = 0
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                loadCount += 1
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {
                      "session_id": "session-streaming",
                      "title": "Streaming work",
                      "archived": false,
                      "active_stream_id": "stream-123"
                    }
                  ]
                }
                """, for: request)
            case "/api/chat/stream/status":
                statusCount += 1
                return apiTestJSONResponse(
                    #"{"active":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        let refreshResult = await viewModel.refreshActiveSessionStatesIfNeeded(streamIDs: ["stream-123"])

        XCTAssertEqual(refreshResult, .unchanged)
        XCTAssertEqual(loadCount, 1)
        XCTAssertEqual(statusCount, 1)
        XCTAssertEqual(viewModel.sessions.first?.activeStreamId, "stream-123")
    }

    @MainActor
    func testActiveStreamStatusUnauthorizedIsPreservedForAuthHandling() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/stream/status":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 401,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"unauthorized"}"#.utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let refreshResult = await viewModel.refreshActiveSessionStatesIfNeeded(streamIDs: ["stream-123"])

        XCTAssertEqual(refreshResult, .failed)
        guard let lastError = viewModel.lastError,
              case APIError.unauthorized = lastError
        else {
            XCTFail("Expected unauthorized lastError, got \(String(describing: viewModel.lastError))")
            return
        }
    }
}
