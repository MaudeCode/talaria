import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testComposerConfigurationUsesSessionProfileDefaultBeforeSending() async throws {
        let openRouterModel = "deepseek/deepseek-chat-v3-0324:free"
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(model: nil, modelProvider: nil, profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "default",
                  "profiles": [
                    {"name": "default", "model": "gpt-5.4", "provider": "openai", "is_default": true},
                    {"name": "work", "model": "\(openRouterModel)", "provider": "openrouter"}
                  ]
                }
                """, for: request)
            case "/api/profile/switch":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["name"] as? String, "work")
                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "default_model": "\(openRouterModel)",
                  "default_workspace": "/tmp/workspace",
                  "profiles": [
                    {"name": "default", "model": "gpt-5.4", "provider": "openai", "is_default": true},
                    {"name": "work", "model": "\(openRouterModel)", "provider": "openrouter", "is_active": true}
                  ]
                }
                """, for: request)
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "default_model": "\(openRouterModel)",
                  "active_provider": "openrouter",
                  "groups": [
                    {
                      "name": "OpenRouter",
                      "provider_id": "openrouter",
                      "models": [
                        {"id": "\(openRouterModel)", "name": "DeepSeek Chat v3 Free"}
                      ]
                    }
                  ]
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            case "/api/workspaces":
                return apiTestJSONResponse(#"{"workspaces": [{"path": "/tmp/workspace"}], "last": "/tmp/workspace"}"#, for: request)
            case "/api/commands":
                return apiTestJSONResponse(#"{"commands": []}"#, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["model"] as? String, openRouterModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")
                XCTAssertEqual(body["profile"] as? String, "work")
                XCTAssertNil(body["explicit_model_pick"])
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-profile"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadComposerConfiguration()
        XCTAssertEqual(viewModel.selectedModelID, openRouterModel)
        XCTAssertEqual(viewModel.selectedProfileTitle, "work")

        let didStart = await viewModel.sendMessage("Use the profile default")

        XCTAssertTrue(didStart)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(requestPaths, [
            "/api/profiles",
            "/api/profile/switch",
            "/api/models",
            "/api/reasoning",
            "/api/workspaces",
            "/api/commands",
            "/api/chat/start"
        ])
    }

    @MainActor
    func testSessionModelOverrideSurvivesProfileDefaultLoad() async throws {
        let openRouterDefault = "deepseek/deepseek-chat-v3-0324:free"
        let sessionModel = "@openai:gpt-5.5"
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(model: sessionModel, modelProvider: "openai", profile: "work")
        ) { request in
            switch request.url?.path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "profiles": [
                    {"name": "work", "model": "\(openRouterDefault)", "provider": "openrouter", "is_active": true}
                  ]
                }
                """, for: request)
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "default_model": "\(openRouterDefault)",
                  "active_provider": "openrouter",
                  "groups": [
                    {
                      "name": "OpenRouter",
                      "provider_id": "openrouter",
                      "models": [
                        {"id": "\(openRouterDefault)", "name": "DeepSeek Chat v3 Free"}
                      ]
                    },
                    {
                      "name": "OpenAI",
                      "provider_id": "openai",
                      "models": [
                        {"id": "\(sessionModel)", "name": "GPT 5.5"}
                      ]
                    }
                  ]
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            case "/api/workspaces":
                return apiTestJSONResponse(#"{"workspaces": [{"path": "/tmp/workspace"}], "last": "/tmp/workspace"}"#, for: request)
            case "/api/commands":
                return apiTestJSONResponse(#"{"commands": []}"#, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["model"] as? String, sessionModel)
                XCTAssertEqual(body["model_provider"] as? String, "openai")
                XCTAssertEqual(body["profile"] as? String, "work")
                XCTAssertNil(body["explicit_model_pick"])
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-override"}"#, for: request)
            case "/api/default-model":
                XCTFail("Session-scoped chat model overrides must not save profile defaults.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadComposerConfiguration()
        XCTAssertEqual(viewModel.selectedModelID, sessionModel)

        let didStart = await viewModel.sendMessage("Keep the session override")

        XCTAssertTrue(didStart)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testComposerConfigurationReloadDoesNotOverwriteConcurrentWorkspaceSelection() async throws {
        let initialWorkspace = "/tmp/workspace"
        let selectedWorkspace = "/tmp/selected-workspace"
        let firstProfilesStarted = expectation(description: "first profiles request started")
        let releaseFirstProfiles = DispatchSemaphore(value: 0)
        let profileRequests = LockedCounter()
        var didReleaseFirstProfiles = false
        func releaseProfilesIfNeeded() {
            guard !didReleaseFirstProfiles else { return }
            didReleaseFirstProfiles = true
            releaseFirstProfiles.signal()
        }

        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            switch request.url?.path {
            case "/api/profiles":
                let requestCount = profileRequests.increment()
                if requestCount == 1 {
                    firstProfilesStarted.fulfill()
                    XCTAssertEqual(releaseFirstProfiles.wait(timeout: .now() + .seconds(5)), .success)
                }

                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "profiles": [
                    {"name": "work", "model": "gpt-5.4", "provider": "openai", "is_active": true}
                  ]
                }
                """, for: request)
            case "/api/session/update":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["workspace"] as? String, selectedWorkspace)
                XCTAssertEqual(body["model"] as? String, "gpt-5.4")
                XCTAssertEqual(body["model_provider"] as? String, "openai")

                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "\(selectedWorkspace)",
                    "model": "gpt-5.4",
                    "model_provider": "openai",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "default_model": "gpt-5.4",
                  "active_provider": "openai",
                  "groups": [
                    {
                      "name": "OpenAI",
                      "provider_id": "openai",
                      "models": [
                        {"id": "gpt-5.4", "name": "GPT 5.4"}
                      ]
                    }
                  ]
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            case "/api/workspaces":
                return apiTestJSONResponse("""
                {
                  "workspaces": [
                    {"path": "\(initialWorkspace)"},
                    {"path": "\(selectedWorkspace)"}
                  ],
                  "last": "\(initialWorkspace)"
                }
                """, for: request)
            case "/api/commands":
                return apiTestJSONResponse(#"{"commands": []}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadComposerConfiguration()
        }
        await fulfillment(of: [firstProfilesStarted], timeout: 1)
        defer { releaseProfilesIfNeeded() }

        let selectWorkspaceTask = Task { @MainActor in
            await viewModel.selectWorkspacePath(selectedWorkspace)
        }
        try await waitUntil { viewModel.selectedWorkspacePath == selectedWorkspace }
        releaseProfilesIfNeeded()

        let didSelectWorkspace = await selectWorkspaceTask.value
        await loadTask.value

        XCTAssertTrue(didSelectWorkspace)
        XCTAssertEqual(viewModel.selectedWorkspacePath, selectedWorkspace)
        XCTAssertEqual(viewModel.selectedModelID, "gpt-5.4")
        XCTAssertEqual(viewModel.selectedModelProviderID, "openai")
        XCTAssertEqual(profileRequests.count, 2)
        XCTAssertNil(viewModel.composerConfigurationErrorMessage)
    }

    @MainActor
    func testDraftSettingsRestoreDoesNotOverwriteANewerComposerInteraction() async throws {
        var requestCount = 0
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            requestCount += 1
            XCTFail("A fenced restore must not call \(request.url?.path ?? "nil").")
            throw URLError(.badURL)
        }
        let expectedGeneration = viewModel.composerConfigurationInteractionGeneration
        viewModel.markComposerConfigurationInteraction()

        await viewModel.restoreDraftSettings(
            ChatDraftSettings(
                modelID: "claude-sonnet-4",
                modelProviderID: "anthropic",
                workspacePath: "/tmp/saved"
            ),
            expectedInteractionGeneration: expectedGeneration
        )

        XCTAssertEqual(viewModel.selectedModelID, "gpt-5.4")
        XCTAssertEqual(viewModel.selectedModelProviderID, "openai")
        XCTAssertEqual(viewModel.selectedWorkspacePath, "/tmp/workspace")
        XCTAssertEqual(requestCount, 0)
    }

    @MainActor
    func testDraftSettingsRestoreStopsWhenSavedProfileSwitchFails() async throws {
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            let path = request.url?.path ?? ""
            requestPaths.append(path)
            switch path {
            case "/api/profiles":
                return apiTestJSONResponse("""
                {
                  "active": "work",
                  "profiles": [
                    {"name": "work", "model": "gpt-5.4", "provider": "openai", "is_active": true},
                    {"name": "saved", "model": "claude-sonnet-4", "provider": "anthropic"}
                  ]
                }
                """, for: request)
            case "/api/models":
                return apiTestJSONResponse("""
                {
                  "groups": [
                    {
                      "name": "Anthropic",
                      "provider_id": "anthropic",
                      "models": [{"id": "claude-sonnet-4", "name": "Claude Sonnet 4"}]
                    }
                  ]
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort":"medium","supported_efforts":["medium","high"]}"#, for: request)
            case "/api/workspaces":
                return apiTestJSONResponse(#"{"workspaces":[{"path":"/tmp/workspace"},{"path":"/tmp/saved"}]}"#, for: request)
            case "/api/commands":
                return apiTestJSONResponse(#"{"commands":[]}"#, for: request)
            case "/api/profile/switch":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (response, Data(#"{"error":"profile unavailable"}"#.utf8))
            case "/api/session/update":
                XCTFail("Dependent model or workspace settings must not apply after profile failure.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(path)")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadComposerConfiguration()
        let expectedGeneration = viewModel.composerConfigurationInteractionGeneration
        await viewModel.restoreDraftSettings(
            ChatDraftSettings(
                modelID: "claude-sonnet-4",
                modelProviderID: "anthropic",
                reasoningEffort: "high",
                profileName: "saved",
                workspacePath: "/tmp/saved"
            ),
            expectedInteractionGeneration: expectedGeneration
        )

        XCTAssertEqual(viewModel.selectedProfileName, "work")
        XCTAssertEqual(viewModel.selectedModelID, "gpt-5.4")
        XCTAssertEqual(viewModel.selectedWorkspacePath, "/tmp/workspace")
        XCTAssertEqual(requestPaths.last, "/api/profile/switch")
        XCTAssertFalse(requestPaths.contains("/api/session/update"))
    }

    @MainActor
    func testSelectingComposerModelUpdatesOnlyTheSessionAndCarriesProviderOnSend() async throws {
        let openRouterModel = "deepseek/deepseek-chat-v3-0324:free"
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: nil, profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/session/update":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["workspace"] as? String, "/tmp/workspace")
                XCTAssertEqual(body["model"] as? String, openRouterModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(openRouterModel)",
                    "model_provider": "openrouter",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["model"] as? String, openRouterModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")
                XCTAssertEqual(body["profile"] as? String, "work")
                XCTAssertEqual(body["explicit_model_pick"] as? Bool, true)
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-selected"}"#, for: request)
            case "/api/default-model":
                XCTFail("Composer model selection must not save profile defaults.")
                throw URLError(.badURL)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: openRouterModel,
            displayName: "DeepSeek Chat v3 Free",
            providerID: "openrouter"
        ))
        XCTAssertEqual(viewModel.selectedModelID, openRouterModel)

        let didStart = await viewModel.sendMessage("Use the selected OpenRouter model")

        XCTAssertTrue(didStart)
        XCTAssertEqual(requestPaths, ["/api/session/update", "/api/reasoning", "/api/chat/start"])
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testExplicitComposerModelPickSurvivesFailedChatStartUntilStreamStarts() async throws {
        let openRouterModel = "deepseek/deepseek-chat-v3-0324:free"
        var chatStartBodies: [[String: Any]] = []
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: nil, profile: "work")
        ) { request in
            switch request.url?.path {
            case "/api/session/update":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(openRouterModel)",
                    "model_provider": "openrouter",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/chat/start":
                chatStartBodies.append(try XCTUnwrap(apiTestJSONBody(from: request)))
                if chatStartBodies.count == 1 {
                    return apiTestJSONResponse(#"{"session_id": "session-abc", "error": "No stream yet"}"#, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-second"
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: openRouterModel,
            displayName: "DeepSeek Chat v3 Free",
            providerID: "openrouter"
        ))

        let didStartFirstMessage = await viewModel.sendMessage("Use the explicit model")
        XCTAssertFalse(didStartFirstMessage)
        XCTAssertEqual(chatStartBodies.first?["explicit_model_pick"] as? Bool, true)

        let didStartSecondMessage = await viewModel.sendMessage("Use the same model again")
        XCTAssertTrue(didStartSecondMessage)
        XCTAssertEqual(chatStartBodies.count, 2)
        XCTAssertEqual(chatStartBodies[1]["explicit_model_pick"] as? Bool, true)
    }

    @MainActor
    func testSelectingCustomComposerModelCarriesExplicitProviderOnSend() async throws {
        let customModel = "moonshotai/kimi-k2-0905"
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/session/update":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["workspace"] as? String, "/tmp/workspace")
                XCTAssertEqual(body["model"] as? String, customModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(customModel)",
                    "model_provider": "openrouter",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["model"] as? String, customModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")
                XCTAssertEqual(body["profile"] as? String, "work")
                XCTAssertEqual(body["explicit_model_pick"] as? Bool, true)
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-custom"}"#, for: request)
            case "/api/default-model":
                XCTFail("Custom composer models must not save Settings defaults.")
                throw URLError(.badURL)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: customModel,
            displayName: customModel,
            providerID: "openrouter"
        ))
        XCTAssertEqual(viewModel.selectedModelID, customModel)
        XCTAssertEqual(viewModel.selectedModelProviderID, "openrouter")
        XCTAssertEqual(viewModel.selectedModelTitle, "kimi-k2-0905")

        let didStart = await viewModel.sendMessage("Use the custom OpenRouter model")

        XCTAssertTrue(didStart)
        XCTAssertEqual(requestPaths, ["/api/session/update", "/api/reasoning", "/api/chat/start"])
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testTypedSlashModelSelectionWithoutCatalogMatchMarksNextChatStartExplicit() async throws {
        let typedModel = "gpt-5.4-mini"
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(model: "claude-sonnet-4", modelProvider: nil, profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/session/update":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["model"] as? String, typedModel)
                XCTAssertNil(body["model_provider"])
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(typedModel)",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["model"] as? String, typedModel)
                XCTAssertNil(body["model_provider"])
                XCTAssertEqual(body["profile"] as? String, "work")
                XCTAssertEqual(body["explicit_model_pick"] as? Bool, true)
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-slash-model"}"#, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await viewModel.executeSlashCommand(
            try XCTUnwrap(SlashCommandCatalog.command(named: "model")),
            args: typedModel
        )
        let didStart = await viewModel.sendMessage("Use the typed model")

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertTrue(didStart)
        XCTAssertEqual(requestPaths, ["/api/session/update", "/api/reasoning", "/api/chat/start"])
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testSelectingCustomComposerModelWhenSessionUpdateFailsDoesNotMutateState() async throws {
        let customModel = "moonshotai/kimi-k2-0905"
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/session/update":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["model"] as? String, customModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")

                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"model update failed"}"#.utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: customModel,
            displayName: customModel,
            providerID: "openrouter"
        ))

        XCTAssertEqual(viewModel.selectedModelID, "gpt-5.4")
        XCTAssertEqual(viewModel.selectedModelProviderID, "openai")
        XCTAssertNotNil(viewModel.composerConfigurationErrorMessage)
        XCTAssertEqual(requestPaths, ["/api/session/update"])
    }

    @MainActor
    func testSelectingCustomComposerModelWhileStreamingIsBlocked() async throws {
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-active"}"#, for: request)
            case "/api/session/update":
                XCTFail("Selecting a composer model while streaming must not call session update.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Start streaming")
        await viewModel.selectComposerModel(ModelCatalogOption(
            id: "moonshotai/kimi-k2-0905",
            displayName: "moonshotai/kimi-k2-0905",
            providerID: "openrouter"
        ))

        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.selectedModelID, "gpt-5.4")
        XCTAssertEqual(viewModel.selectedModelProviderID, "openai")
        XCTAssertEqual(
            viewModel.composerConfigurationErrorMessage,
            "Wait for the current response to finish before changing models."
        )
        XCTAssertEqual(requestPaths, ["/api/chat/start"])
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testSelectingCustomComposerModelWithNilSessionIDIsBlocked() async throws {
        let session = SessionSummary(
            sessionId: nil,
            title: "Planning",
            workspace: "/tmp/workspace",
            model: "gpt-5.4",
            modelProvider: "openai",
            profile: "work"
        )
        let viewModel = try makeViewModel(sessionSummary: session) { request in
            XCTFail("Selecting a composer model without a session ID must not call \(request.url?.path ?? "nil").")
            throw URLError(.badURL)
        }

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: "moonshotai/kimi-k2-0905",
            displayName: "moonshotai/kimi-k2-0905",
            providerID: "openrouter"
        ))

        XCTAssertEqual(viewModel.selectedModelID, "gpt-5.4")
        XCTAssertEqual(viewModel.selectedModelProviderID, "openai")
        XCTAssertEqual(viewModel.composerConfigurationErrorMessage, "The server did not provide a session ID.")
    }

    @MainActor
    func testSelectingCustomComposerModelSessionUpdateOmittingProviderFallsBackToOptionProvider() async throws {
        let customModel = "moonshotai/kimi-k2-0905"
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/session/update":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["model"] as? String, customModel)
                XCTAssertEqual(body["model_provider"] as? String, "openrouter")
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(customModel)",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: customModel,
            displayName: customModel,
            providerID: "openrouter"
        ))

        XCTAssertEqual(viewModel.selectedModelID, customModel)
        XCTAssertEqual(viewModel.selectedModelProviderID, "openrouter")
        XCTAssertNil(viewModel.composerConfigurationErrorMessage)
        XCTAssertEqual(requestPaths, ["/api/session/update", "/api/reasoning"])
    }

    @MainActor
    func testSelectingComposerModelRefreshesEffortGatingAndSnapsUnsupportedEffort() async throws {
        let limitedModel = "o4-mini"
        var reasoningQueries: [[String: String?]] = []
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            switch request.url?.path {
            case "/api/reasoning" where request.httpMethod == "POST":
                return apiTestJSONResponse(#"{"ok": true, "reasoning_effort": "xhigh"}"#, for: request)
            case "/api/session/update":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(limitedModel)",
                    "model_provider": "openai",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/reasoning":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                reasoningQueries.append(Dictionary(
                    uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) }
                ))
                return apiTestJSONResponse("""
                {
                  "show_reasoning": true,
                  "reasoning_effort": "high",
                  "supported_efforts": ["low", "medium", "high"],
                  "supports_reasoning_effort": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.selectReasoningEffort("xhigh")
        XCTAssertEqual(viewModel.selectedReasoningEffort, "xhigh")

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: limitedModel,
            displayName: limitedModel,
            providerID: "openai"
        ))

        // The gating query is scoped to the newly selected model, never stale
        // session state (upstream #3750 class of bug).
        XCTAssertEqual(reasoningQueries.count, 1)
        XCTAssertEqual(reasoningQueries[0]["model"], limitedModel)
        XCTAssertEqual(reasoningQueries[0]["provider"], "openai")
        XCTAssertEqual(viewModel.supportedReasoningEfforts, ["low", "medium", "high"])
        XCTAssertEqual(viewModel.supportsReasoningEffort, true)
        XCTAssertTrue(viewModel.showsReasoningEffortControl)
        // "xhigh" is not supported by the new model: snap to the server's
        // coerced reasoning_effort.
        XCTAssertEqual(viewModel.selectedReasoningEffort, "high")
    }

    @MainActor
    func testSelectingComposerModelHidesEffortControlWhenUnsupported() async throws {
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            switch request.url?.path {
            case "/api/session/update":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "no-effort-model",
                    "model_provider": "openai",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/reasoning":
                return apiTestJSONResponse("""
                {
                  "show_reasoning": true,
                  "reasoning_effort": "",
                  "supported_efforts": [],
                  "supports_reasoning_effort": false
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        XCTAssertTrue(viewModel.showsReasoningEffortControl)

        await viewModel.selectComposerModel(ModelCatalogOption(
            id: "no-effort-model",
            displayName: "no-effort-model",
            providerID: "openai"
        ))

        XCTAssertEqual(viewModel.supportedReasoningEfforts, [])
        XCTAssertEqual(viewModel.supportsReasoningEffort, false)
        XCTAssertFalse(viewModel.showsReasoningEffortControl)
    }

    @MainActor
    func testEffortGatingRefreshFailureResetsStaleGatingToFallback() async throws {
        // First switch lands restrictive gating (no effort support); the second
        // switch succeeds but its gating refresh fails. The stale "hidden"
        // gating from the first model must not stick to the new model — it
        // resets to the unknown fallback (static list, control shown).
        var reasoningCalls = 0
        var sessionModel = "gpt-5.4"
        let viewModel = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5.4", modelProvider: "openai", profile: "work")
        ) { request in
            switch request.url?.path {
            case "/api/session/update":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/workspace",
                    "model": "\(sessionModel)",
                    "model_provider": "openai",
                    "profile": "work"
                  }
                }
                """, for: request)
            case "/api/reasoning":
                reasoningCalls += 1
                if reasoningCalls == 1 {
                    return apiTestJSONResponse("""
                    {
                      "show_reasoning": true,
                      "reasoning_effort": "",
                      "supported_efforts": [],
                      "supports_reasoning_effort": false
                    }
                    """, for: request)
                }
                throw URLError(.timedOut)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        sessionModel = "no-effort-model"
        let didSelectFirst = await viewModel.selectComposerModel(ModelCatalogOption(
            id: "no-effort-model",
            displayName: "no-effort-model",
            providerID: "openai"
        ))
        XCTAssertTrue(didSelectFirst)
        XCTAssertEqual(viewModel.supportsReasoningEffort, false)
        XCTAssertFalse(viewModel.showsReasoningEffortControl)

        sessionModel = "flaky-model"
        let didSelect = await viewModel.selectComposerModel(ModelCatalogOption(
            id: "flaky-model",
            displayName: "flaky-model",
            providerID: "openai"
        ))

        // The model change still succeeds; the failed refresh drops the stale
        // gating instead of applying it to the new model.
        XCTAssertTrue(didSelect)
        XCTAssertEqual(viewModel.selectedModelID, "flaky-model")
        XCTAssertNil(viewModel.supportedReasoningEfforts)
        XCTAssertNil(viewModel.supportsReasoningEffort)
        XCTAssertTrue(viewModel.showsReasoningEffortControl)
        XCTAssertNil(viewModel.composerConfigurationErrorMessage)
    }

    @MainActor
    func testSelectedModelTitleRequiresExactProviderCatalogMatch() async throws {
        func makeConfiguredViewModel(
            model: String,
            provider: String?,
            modelsJSON: String
        ) throws -> ChatViewModel {
            try makeViewModel(
                sessionSummary: makeSession(model: model, modelProvider: provider)
            ) { request in
                switch request.url?.path {
                case "/api/profiles":
                    return apiTestJSONResponse(#"{"profiles": []}"#, for: request)
                case "/api/models":
                    return apiTestJSONResponse(modelsJSON, for: request)
                case "/api/reasoning":
                    return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
                case "/api/workspaces":
                    return apiTestJSONResponse(#"{"workspaces": []}"#, for: request)
                case "/api/commands":
                    return apiTestJSONResponse(#"{"commands": []}"#, for: request)
                default:
                    XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                    throw URLError(.badURL)
                }
            }
        }

        let exact = try makeConfiguredViewModel(
            model: "shared/model",
            provider: "openai",
            modelsJSON: """
            {
              "groups": [
                {
                  "name": "OpenAI",
                  "provider_id": "openai",
                  "models": [{"id": "shared/model", "name": "OpenAI Shared"}]
                },
                {
                  "name": "Anthropic",
                  "provider_id": "anthropic",
                  "models": [{"id": "shared/model", "name": "Anthropic Shared"}]
                }
              ]
            }
            """
        )

        await exact.loadComposerConfiguration()
        XCTAssertEqual(exact.selectedModelTitle, "OpenAI Shared")

        let providerMismatch = try makeConfiguredViewModel(
            model: "shared/model",
            provider: "openrouter",
            modelsJSON: """
            {
              "groups": [
                {
                  "name": "OpenAI",
                  "provider_id": "openai",
                  "models": [{"id": "shared/model", "name": "OpenAI Shared"}]
                }
              ]
            }
            """
        )

        await providerMismatch.loadComposerConfiguration()
        XCTAssertEqual(providerMismatch.selectedModelTitle, "model")

        let unknownCustom = try makeConfiguredViewModel(
            model: "vendor/custom-model",
            provider: "openrouter",
            modelsJSON: #"{"groups": []}"#
        )

        await unknownCustom.loadComposerConfiguration()
        XCTAssertEqual(unknownCustom.selectedModelTitle, "custom-model")
    }

    /// A composer `.task(id:)` that restarts while a catalog request is in flight
    /// must neither cancel the request nor let the replacement caller see an empty
    /// catalog as loaded (TAL-160).
    func testSkillSuggestionLoadIsSharedAndSurvivesACancelledCaller() async throws {
        let requests = DeferredRequests()
        let host = "tal160-skills.test"
        let requestStarted = expectation(description: "skills request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            XCTAssertEqual(request.request.url?.path, "/api/skills")
            _ = requests.append(request)
            requestStarted.fulfill()
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let cancelledCaller = Task { @MainActor in
            await viewModel.loadSkillSlashSuggestions()
        }
        await fulfillment(of: [requestStarted], timeout: 2)
        var survivingCallerFinished = false
        let survivingCaller = Task { @MainActor in
            await viewModel.loadSkillSlashSuggestions()
            survivingCallerFinished = true
        }
        cancelledCaller.cancel()
        await drainMainActor()

        XCTAssertEqual(requests.count, 1, "Concurrent callers share one fetch")
        XCTAssertFalse(survivingCallerFinished, "A waiter must not observe completion before the fetch finishes")

        requests.request(at: 0).complete(withJSON: #"{"skills": [{"name": "Deploy", "category": "ops"}]}"#)
        await survivingCaller.value

        XCTAssertEqual(viewModel.skillSlashSuggestions.map(\.name), ["Deploy"])
        XCTAssertNil(viewModel.lastError)

        await viewModel.loadSkillSlashSuggestions()
        XCTAssertEqual(requests.count, 1, "A successful load is cached")
    }

    func testSkillSuggestionLoadRetriesAfterFailureAndCachesAnEmptyCatalog() async throws {
        let requests = DeferredRequests()
        let host = "tal160-skills-retry.test"
        DeferredMockURLProtocol.setOnRequest({ _ = requests.append($0) }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let failingCaller = Task { @MainActor in
            await viewModel.loadSkillSlashSuggestions()
        }
        try await waitUntil { requests.count == 1 }
        requests.request(at: 0).fail(with: URLError(.timedOut))
        await failingCaller.value
        XCTAssertNotNil(viewModel.lastError)

        let retryingCaller = Task { @MainActor in
            await viewModel.loadSkillSlashSuggestions()
        }
        try await waitUntil { requests.count == 2 }
        requests.request(at: 1).complete(withJSON: #"{"skills": []}"#)
        await retryingCaller.value

        XCTAssertEqual(viewModel.skillSlashSuggestions, [])
        await viewModel.loadSkillSlashSuggestions()
        XCTAssertEqual(requests.count, 2, "An empty catalog is still cached")
    }

    func testPersonalitySuggestionLoadIsSharedAndRetriesAfterFailure() async throws {
        let requests = DeferredRequests()
        let host = "tal160-personalities.test"
        DeferredMockURLProtocol.setOnRequest({ request in
            XCTAssertEqual(request.request.url?.path, "/api/personalities")
            _ = requests.append(request)
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let cancelledCaller = Task { @MainActor in
            await viewModel.loadPersonalitySuggestions()
        }
        try await waitUntil { requests.count == 1 }
        let survivingCaller = Task { @MainActor in
            await viewModel.loadPersonalitySuggestions()
        }
        cancelledCaller.cancel()
        await drainMainActor()
        XCTAssertEqual(requests.count, 1, "Concurrent callers share one fetch")

        requests.request(at: 0).fail(with: URLError(.timedOut))
        await survivingCaller.value
        XCTAssertNotNil(viewModel.composerConfigurationErrorMessage)
        XCTAssertEqual(viewModel.personalitySuggestions, ["none"])

        let retryingCaller = Task { @MainActor in
            await viewModel.loadPersonalitySuggestions()
        }
        try await waitUntil { requests.count == 2 }
        requests.request(at: 1).complete(withJSON: #"{"personalities": [{"name": "Pirate"}]}"#)
        await retryingCaller.value

        XCTAssertEqual(viewModel.personalitySuggestions, ["none", "Pirate"])
        await viewModel.loadPersonalitySuggestions()
        XCTAssertEqual(requests.count, 2, "A successful load is cached")
    }
}
