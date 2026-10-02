import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testSkillShortcutWithoutArgsReturnsLocalSkillInfoWithoutStartingChat() async throws {
        var didRequestSkills = false
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/skills":
                didRequestSkills = true
                return apiTestJSONResponse("""
                {
                  "skills": [
                    {
                      "name": "Spotify",
                      "category": "media",
                      "description": "Control Spotify playback."
                    }
                  ]
                }
                """, for: request)
            case "/api/chat/start":
                XCTFail("Skill shortcut without args should not start chat.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await viewModel.executeSkillShortcutCommand(name: "spotify", args: "")

        XCTAssertTrue(didRequestSkills)
        guard case .executed(let message) = result else {
            XCTFail("Expected local skill detail response.")
            return
        }
        let unwrappedMessage = try XCTUnwrap(message)
        XCTAssertTrue(unwrappedMessage.contains("### `/spotify`"))
        XCTAssertTrue(unwrappedMessage.contains("Control Spotify playback."))
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testSkillShortcutWithArgsStartsChatMessage() async throws {
        var startedMessage: String?
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/skills":
                return apiTestJSONResponse("""
                {
                  "skills": [
                    {
                      "name": "Spotify",
                      "category": "media",
                      "description": "Control Spotify playback."
                    }
                  ]
                }
                """, for: request)
            case "/api/chat/start":
                let data = try XCTUnwrap(apiTestBodyData(from: request))
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                startedMessage = body["message"] as? String
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await viewModel.executeSkillShortcutCommand(name: "spotify", args: "check songs")

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(startedMessage, "/spotify check songs")
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testEditUserMessageTruncatesBeforeMessageThenStartsChatWithEditedText() async throws {
        var requestPaths: [String] = []
        var truncateKeepCount: Int?
        var startedMessage: String?
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            requestPaths.append(request.url?.path ?? "")
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "_messages_offset": 10,
                    "messages": [
                      {"role": "user", "content": "First question", "timestamp": 1, "message_id": "u-10"},
                      {"role": "assistant", "content": "First answer", "timestamp": 2, "message_id": "a-11"},
                      {"role": "user", "content": "Original question", "timestamp": 3, "message_id": "u-12"},
                      {"role": "assistant", "content": "Original answer", "timestamp": 4, "message_id": "a-13"}
                    ]
                  }
                }
                """, for: request)
            case "/api/session/truncate":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                truncateKeepCount = body["keep_count"] as? Int
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "_messages_offset": 10,
                    "messages": [
                      {"role": "user", "content": "First question", "timestamp": 1, "message_id": "u-10"},
                      {"role": "assistant", "content": "First answer", "timestamp": 2, "message_id": "a-11"}
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                startedMessage = body["message"] as? String
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-edit"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let context = try XCTUnwrap(viewModel.actionContext(for: viewModel.messages[2], visibleIndex: 2))
        let didEdit = await viewModel.editMessage(context, newText: "  Edited question  ")

        XCTAssertTrue(didEdit)
        XCTAssertEqual(requestPaths, ["/api/session", "/api/session/truncate", "/api/chat/start"])
        XCTAssertEqual(truncateKeepCount, 12)
        XCTAssertEqual(startedMessage, "Edited question")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["First question", "First answer", "Edited question"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-edit")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testRegenerateAssistantResponseUsesPrecedingUserAndTruncatesAtAssistantIndex() async throws {
        var truncateKeepCount: Int?
        var startedMessage: String?
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "_messages_offset": 5,
                    "messages": [
                      {"role": "user", "content": "First question", "timestamp": 1, "message_id": "u-5"},
                      {"role": "assistant", "content": "First answer", "timestamp": 2, "message_id": "a-6"},
                      {"role": "user", "content": "Second question", "timestamp": 3, "message_id": "u-7"},
                      {"role": "assistant", "content": "Second answer", "timestamp": 4, "message_id": "a-8"}
                    ]
                  }
                }
                """, for: request)
            case "/api/session/truncate":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                truncateKeepCount = body["keep_count"] as? Int
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "_messages_offset": 5,
                    "messages": [
                      {"role": "user", "content": "First question", "timestamp": 1, "message_id": "u-5"},
                      {"role": "assistant", "content": "First answer", "timestamp": 2, "message_id": "a-6"},
                      {"role": "user", "content": "Second question", "timestamp": 3, "message_id": "u-7"}
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                startedMessage = body["message"] as? String
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-regen"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let context = try XCTUnwrap(viewModel.actionContext(for: viewModel.messages[3], visibleIndex: 3))
        let didRegenerate = await viewModel.regenerateAssistantResponse(context)

        XCTAssertTrue(didRegenerate)
        XCTAssertEqual(truncateKeepCount, 8)
        XCTAssertEqual(startedMessage, "Second question")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["First question", "First answer", "Second question"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-regen")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    /// The list row said nothing about read-only; the loaded detail is authoritative.
    @MainActor
    func testReadOnlySessionRejectsEditAndRegenerateWithoutTruncating() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "read_only": true,
                    "messages": [
                      {"role": "user", "content": "Question", "timestamp": 1, "message_id": "u-1"},
                      {"role": "assistant", "content": "Answer", "timestamp": 2, "message_id": "a-2"}
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Read-only session must not mutate the transcript: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        XCTAssertFalse(viewModel.isSessionReadOnly)
        await viewModel.loadMessages()
        XCTAssertTrue(viewModel.isSessionReadOnly)
        let userContext = try XCTUnwrap(viewModel.actionContext(for: viewModel.messages[0], visibleIndex: 0))
        let assistantContext = try XCTUnwrap(viewModel.actionContext(for: viewModel.messages[1], visibleIndex: 1))

        let didEdit = await viewModel.editMessage(userContext, newText: "Edited")
        XCTAssertFalse(didEdit)
        XCTAssertEqual(viewModel.messageActionErrorMessage, "This session is view-only and can't be edited.")

        let didRegenerate = await viewModel.regenerateAssistantResponse(assistantContext)
        XCTAssertFalse(didRegenerate)
        XCTAssertEqual(viewModel.messageActionErrorMessage, "This session is view-only and can't be regenerated.")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Question", "Answer"])
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testLoadedDetailRefreshesStaleReadOnlySeedFromTheListRow() async throws {
        let viewModel = try makeViewModel(sessionSummary: makeSession(readOnly: true)) { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse(#"{"session": {"session_id": "session-abc", "read_only": false, "messages": []}}"#, for: request)
        }

        XCTAssertTrue(viewModel.isSessionReadOnly)
        await viewModel.loadMessages()
        XCTAssertFalse(viewModel.isSessionReadOnly)
    }

    /// A superseded load's response arriving last must not overwrite the
    /// read-only flag the accepted load applied.
    @MainActor
    func testSupersededLoadResponseDoesNotOverwriteReadOnlyState() async throws {
        let requests = DeferredRequests()
        let host = "tal152-readonly-overlap.test"
        let firstRequestStarted = expectation(description: "first session request started")
        let secondRequestStarted = expectation(description: "second session request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            XCTAssertEqual(request.request.url?.path, "/api/session")
            (requests.append(request) == 1 ? firstRequestStarted : secondRequestStarted).fulfill()
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
        let olderLoad = Task { @MainActor in await viewModel.loadMessages() }
        await fulfillment(of: [firstRequestStarted], timeout: 10)
        let newerLoad = Task { @MainActor in await viewModel.loadMessages() }
        await fulfillment(of: [secondRequestStarted], timeout: 10)

        requests.request(at: 1).complete(withJSON: #"{"session": {"session_id": "session-abc", "read_only": true, "messages": []}}"#)
        await newerLoad.value
        XCTAssertTrue(viewModel.isSessionReadOnly)

        requests.request(at: 0).complete(withJSON: #"{"session": {"session_id": "session-abc", "read_only": false, "messages": []}}"#)
        await olderLoad.value
        XCTAssertTrue(viewModel.isSessionReadOnly)
    }

    @MainActor
    func testForkFromMessageUsesKeepCountThroughMessageAndHandlesMissingForkID() async throws {
        var branchBodies: [[String: Any]] = []
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/session":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                if query["session_id"] == "fork-123" {
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "fork-123",
                        "title": "Forked thread"
                      }
                    }
                    """, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "_messages_offset": 4,
                    "messages": [
                      {"role": "user", "content": "Question", "timestamp": 1, "message_id": "u-4"},
                      {"role": "assistant", "content": "Answer", "timestamp": 2, "message_id": "a-5"}
                    ]
                  }
                }
                """, for: request)
            case "/api/session/branch":
                branchBodies.append(try XCTUnwrap(apiTestJSONBody(from: request)))
                if branchBodies.count == 1 {
                    return apiTestJSONResponse("""
                    {
                      "session_id": "fork-123",
                      "parent_session_id": "session-abc"
                    }
                    """, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "error": "Could not fork"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let context = try XCTUnwrap(viewModel.actionContext(for: viewModel.messages[1], visibleIndex: 1))
        let forked = await viewModel.forkFromMessage(context)
        let missingID = await viewModel.forkFromMessage(context)

        XCTAssertEqual(branchBodies.count, 2)
        XCTAssertEqual(branchBodies[0]["session_id"] as? String, "session-abc")
        XCTAssertEqual(branchBodies[0]["keep_count"] as? Int, 6)
        XCTAssertEqual(forked?.sessionId, "fork-123")
        XCTAssertNil(missingID)
        XCTAssertEqual(viewModel.messageActionErrorMessage, "Could not fork")
    }

    @MainActor
    func testUndoSlashCommandCallsServerThenReloadsMessages() async throws {
        var requestPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestPaths.append(request.url?.path ?? "")
            switch request.url?.path {
            case "/api/session/undo":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "removed_count": 2
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Remaining message", "timestamp": 1, "message_id": "u-1"}
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "undo")))

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(requestPaths, ["/api/session/undo", "/api/session"])
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Remaining message"])
    }

    @MainActor
    func testUndoSlashCommandIsBlockedWhileStreaming() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session/undo":
                XCTFail("Undo should not call the server while streaming.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        let result = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "undo")))

        XCTAssertEqual(result, .unsupported(friendlyMessage: "Wait for the current response to finish before undoing messages."))
    }

    @MainActor
    func testRetrySlashCommandReloadsTruncatedSessionThenStartsChatWithLastUserText() async throws {
        var requestPaths: [String] = []
        var startedMessage: String?
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            requestPaths.append(request.url?.path ?? "")
            switch request.url?.path {
            case "/api/session/retry":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "last_user_text": "Summarize the logs",
                  "removed_count": 2
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Earlier message", "timestamp": 1, "message_id": "u-1"}
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/start":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                startedMessage = body["message"] as? String
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-retry"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "retry")))

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(requestPaths, ["/api/session/retry", "/api/session", "/api/chat/start"])
        XCTAssertEqual(startedMessage, "Summarize the logs")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Earlier message", "Summarize the logs"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-retry")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testRetrySlashCommandHandlesMissingLastUserTextAndMissingStreamID() async throws {
        var retryCount = 0
        var startCount = 0
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/session/retry":
                retryCount += 1
                if retryCount == 1 {
                    return apiTestJSONResponse("""
                    {
                      "ok": true,
                      "removed_count": 2
                    }
                    """, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "last_user_text": "Try again",
                  "removed_count": 2
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": []
                  }
                }
                """, for: request)
            case "/api/chat/start":
                startCount += 1
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "error": "No stream"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let retry = try XCTUnwrap(SlashCommandCatalog.command(named: "retry"))
        let missingTextResult = await viewModel.executeSlashCommand(retry)
        let missingStreamResult = await viewModel.executeSlashCommand(retry)

        XCTAssertEqual(
            missingTextResult,
            .unsupported(friendlyMessage: "The server did not return a message to retry.")
        )
        XCTAssertEqual(
            missingStreamResult,
            .unsupported(friendlyMessage: "No stream")
        )
        XCTAssertEqual(startCount, 1)
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testRetrySlashCommandFallbackLoadDoesNotWaitOnItself() async throws {
        var requestPaths: [String] = []
        var sessionRequestCount = 0
        let viewModel = try makeViewModel { request in
            requestPaths.append(request.url?.path ?? "")
            switch request.url?.path {
            case "/api/session/retry":
                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "last_user_text": "Try again",
                  "removed_count": 2
                }
                """, for: request)
            case "/api/session":
                sessionRequestCount += 1
                if sessionRequestCount == 1 {
                    return apiTestJSONResponse("{}", for: request)
                }
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Earlier message", "timestamp": 1, "message_id": "u-1"}
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-retry"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "retry")))

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(requestPaths, ["/api/session/retry", "/api/session", "/api/session", "/api/chat/start"])
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Earlier message", "Try again"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-retry")
    }

    @MainActor
    func testRetrySlashCommandInvalidatesOlderReloadBeforeReplacingTranscript() async throws {
        let requests = DeferredRequests()
        let host = "tal116-retry-overlap.test"
        let outerSessionRequestStarted = expectation(description: "outer session request started")
        let retryRequestStarted = expectation(description: "retry request started")
        let retrySessionRequestStarted = expectation(description: "retry session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            let requestCount = requests.append(request)
            switch request.request.url?.path {
            case "/api/session":
                (requestCount == 1 ? outerSessionRequestStarted : retrySessionRequestStarted).fulfill()
            case "/api/session/retry":
                retryRequestStarted.fulfill()
            case "/api/chat/start":
                chatStartRequestStarted.fulfill()
            default:
                XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [outerSessionRequestStarted], timeout: 10)
        let retryTask = Task { @MainActor in
            await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "retry")))
        }
        await fulfillment(of: [retryRequestStarted], timeout: 10)

        requests.request(at: 1).complete(withJSON: """
        {
          "ok": true,
          "last_user_text": "Try again",
          "removed_count": 2
        }
        """)
        await fulfillment(of: [retrySessionRequestStarted], timeout: 10)
        requests.request(at: 2).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {"role": "user", "content": "Earlier message", "timestamp": 1, "message_id": "u-1"}
            ]
          }
        }
        """)
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)

        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {"role": "user", "content": "Earlier message", "timestamp": 1, "message_id": "u-1"},
              {"role": "assistant", "content": "Old answer", "timestamp": 2, "message_id": "a-1"}
            ]
          }
        }
        """)
        await drainMainActor()
        requests.request(at: 3).complete(withJSON: """
        {
          "session_id": "session-abc",
          "stream_id": "stream-retry"
        }
        """)
        let retryResult = try await retryTask.value
        await loadTask.value

        XCTAssertEqual(retryResult, .executed(message: nil))
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Earlier message", "Try again"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-retry")
    }

    @MainActor
    func testClearSlashCommandClearsLocalTranscriptWithoutServerRequest() async throws {
        var requestCount = 0
        let viewModel = try makeViewModel { request in
            requestCount += 1
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Question", "timestamp": 1, "message_id": "u-1"},
                      {"role": "assistant", "content": "Answer", "timestamp": 2, "message_id": "a-2"}
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Clear should not call \(request.url?.path ?? "unknown path").")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let result = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "clear")))

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertEqual(requestCount, 1)
    }

    @MainActor
    func testAcceptedSteerRendersActualMessageInsideRunningTurnAndSettlesOnDone() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Before hint. "))

        let result = await viewModel.executeSlashCommand(
            try XCTUnwrap(SlashCommandCatalog.command(named: "steer")),
            args: "Use the focused test"
        )

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(viewModel.messages.map(\.role), ["user", "assistant", "user"])
        XCTAssertEqual(
            viewModel.messages.map(\.content),
            ["Initial request", "Before hint. ", "Use the focused test"]
        )
        XCTAssertEqual(viewModel.messages.last?.name, "_talaria_steer_waiting")
        XCTAssertTrue(viewModel.pinnedLocalNotices.isEmpty)

        streamClient.emit(.token("After hint."))
        XCTAssertEqual(viewModel.messages.map(\.role), ["user", "assistant", "user", "assistant"])
        XCTAssertEqual(
            viewModel.messages.map(\.content),
            ["Initial request", "Before hint. ", "Use the focused test", "After hint."]
        )

        let steerID = try XCTUnwrap(viewModel.messages[2].messageId)
        streamClient.emit(.steerConsumed(SteeringStreamEvent(steerId: steerID, text: "Use the focused test")))
        let completedSession = try makeSessionDetail(
            """
            {
              "session_id": "session-abc",
              "messages": [
                {"role":"user","content":"Initial request","message_id":"user-1","_turn_id":"stream-123"},
                {"role":"user","content":"Use the focused test","_turn_id":"stream-123","_steer":{"steer_id":"\(steerID)","submitted_at":3,"consumed_at":4,"phase_duration":4}},
                {
                  "role":"assistant","content":"Before hint. After hint.","message_id":"assistant-final","_turn_id":"stream-123",
                  "_turn_duration":10,
                  "_anchor_activity_scene": {
                    "version":"activity_scene_v1",
                    "final_answer":"After hint.",
                    "turn_duration":10,
                    "final_phase_duration":6,
                    "activity_rows":[
                      {"row_id":"prose-1","order_index":0,"role":"prose","created_at":1,"text":"Before hint. "},
                      {"row_id":"steering:\(steerID)","order_index":1,"role":"steering","created_at":4,"text":"Use the focused test","steering":{"steer_id":"\(steerID)","consumed":true,"submitted_at":3,"consumed_at":4,"phase_duration":4}}
                    ]
                  }
                }
              ]
            }
            """
        )
        streamClient.emit(.done(DoneStreamEvent(
            usage: ContextWindowSnapshot(
                contextLength: nil,
                thresholdTokens: nil,
                lastPromptTokens: nil,
                inputTokens: nil,
                outputTokens: nil,
                estimatedCost: nil,
                durationSeconds: 10
            ),
            session: completedSession
        )))

        // The server's persisted steer replaces the local hint; the turn renders from its scene.
        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
        XCTAssertEqual(viewModel.messages.map(\.role), ["user", "user", "assistant"])
        XCTAssertNotNil(viewModel.messages[1].steer)
        XCTAssertNil(viewModel.actionContext(for: viewModel.messages[1], visibleIndex: 1))
        let assistant = try XCTUnwrap(viewModel.messages.last)
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: assistant))
        let turn = try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))
        XCTAssertEqual(turn.phases.compactMap { $0.steeringAfter?.text }, ["Use the focused test"])
        XCTAssertEqual(
            turn.phaseDurations(totalDuration: 10, finalPhaseDuration: assistant.activityScene?.finalPhaseDuration)
                .compactMap { $0 },
            [4, 6]
        )
        XCTAssertFalse(viewModel.messages.contains { $0.content == "Steering hint delivered." })
    }

    @MainActor
    func testSteerDuringBackgroundTurnFollowsTheUsersOwnTurn() async throws {
        let streamClient = SpySSEStreamingClient()
        var sessionReads = 0
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-bg"}"#, for: request)
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-user","started_turn":{"stream_id":"stream-user","session_id":"session-abc","turn_id":"stream-user"}}"#,
                    for: request
                )
            case "/api/session":
                sessionReads += 1
                return apiTestJSONResponse(
                    #"{"session":{"session_id":"session-abc","active_stream_id":"stream-user","is_streaming":true,"active_turn_origin":"user","pending_started_at":5,"messages":[{"role":"user","content":"[IMPORTANT: Background process proc_1 completed (exit_code=0).]","message_id":"wake","_turn_id":"stream-bg","_background_update":{"kind":"process","attention":false,"count":1,"summary":"s","lines":[{"kind":"command","status":"completed","label":"make","exit_code":0}]}},{"role":"user","content":"What about my question?","message_id":"mine","_turn_id":"stream-user"}]}}"#,
                    for: request
                )
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        let result = await viewModel.executeSlashCommand(
            try XCTUnwrap(SlashCommandCatalog.command(named: "steer")),
            args: "What about my question?"
        )

        // TAL-460: the server started the user's own turn; the view model follows it instead of waiting on a steer.
        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(viewModel.activeStreamID, "stream-user")
        XCTAssertGreaterThan(sessionReads, 0)
        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
        XCTAssertEqual(viewModel.messages.last?.content, "What about my question?")
        XCTAssertEqual(viewModel.messages.first?.backgroundUpdate?.lines, [BackgroundLine(kind: .command, status: .completed, label: "make", exitCode: 0)])
        XCTAssertFalse(viewModel.isBackgroundTurnActive)
        XCTAssertEqual(streamClient.startedURLs.last?.query?.contains("stream-user"), true)
    }

    @MainActor
    func testCompletedSteeringHintSurvivesAuthoritativeActivitySceneReload() async throws {
        let streamClient = SpySSEStreamingClient()
        let modelContext = try makeContext()
        let completedSessionJSON = """
        {
          "session_id": "session-abc",
          "messages": [
            {"role":"user","content":"Initial request","message_id":"user-1"},
            {
              "role":"assistant",
              "content":"Before hint. Final answer.",
              "message_id":"assistant-final",
              "_turn_duration":10,
              "_anchor_activity_scene": {
                "version":"activity_scene_v1",
                "final_answer":"Final answer.",
                "turn_duration":10,
                "activity_rows":[
                  {"row_id":"prose-1","order_index":0,"role":"prose","created_at":1,"text":"Before hint. "},
                  {"row_id":"tool:call-1","order_index":1,"role":"tool","created_at":2,"tool":{"id":"call-1","name":"read_file","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}},
                  {"row_id":"steering:local-steer-authoritative","order_index":2,"role":"steering","created_at":4,"text":"Keep this visible","steering":{"steer_id":"local-steer-authoritative","consumed":true,"submitted_at":3,"consumed_at":4}},
                  {"row_id":"tool:call-2","order_index":3,"role":"tool","created_at":7,"tool":{"id":"call-2","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}
                ]
              }
            }
          ]
        }
        """
        let completedSession = try makeSessionDetail(completedSessionJSON)
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/session":
                return apiTestJSONResponse("{\"session\":\(completedSessionJSON)}", for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request", modelContext: modelContext)
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Before hint. "))
        _ = await viewModel.submitStreamingMessage("Keep this visible", behavior: .steer)
        let steerID = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerConsumed(SteeringStreamEvent(steerId: steerID, text: "Keep this visible")))
        streamClient.emit(.token("Final answer."))
        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))
        streamClient.emit(.streamEnd)
        viewModel.cacheCompletedResponse(modelContext: modelContext)

        await viewModel.loadMessages(modelContext: modelContext)

        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
        let assistant = try XCTUnwrap(viewModel.messages.last(where: { $0.role == "assistant" }))
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: assistant))
        let turn = try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))
        XCTAssertTrue(turn.hasSteering)
        XCTAssertEqual(turn.phases.compactMap { $0.steeringAfter?.text }, ["Keep this visible"])
        XCTAssertEqual(turn.phaseDurations(totalDuration: assistant.turnDuration).compactMap { $0 }, [3, 7])
    }

    @MainActor
    func testCompletionDropsTheLocalHintWhenTheSceneSaysTheTurnTookASteer() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/chat/steer":
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-123"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        _ = await viewModel.sendMessage("Initial request")
        streamClient.emit(.token("Working. "))
        _ = await viewModel.submitStreamingMessage("Keep this once", behavior: .steer)
        XCTAssertTrue(viewModel.messages.contains(where: \.isLocalSteeringHint))

        // A long turn: the persisted steer row is outside the terminal window, and `done` precedes `steer_consumed`.
        let completedSession = try makeSessionDetail(
            """
            {
              "session_id": "session-abc",
              "messages": [
                {"role":"assistant","content":"Final.","message_id":"assistant-final","_turn_id":"stream-123",
                 "_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"Final.","activity_rows_offset":90,"has_consumed_steering":true,"activity_rows":[]}}
              ]
            }
            """
        )
        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
    }

    @MainActor
    func testErrorFrameSessionReplacesTheLiveTurnWithTheServerScene() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        _ = await viewModel.sendMessage("Initial request")
        streamClient.emit(.token("Partial work. "))

        let settled = try makeSessionDetail(
            """
            {
              "session_id": "session-abc",
              "messages": [
                {"role":"user","content":"Initial request","message_id":"user-1","_turn_id":"stream-123"},
                {"role":"assistant","content":"**Error:** boom","message_id":"assistant-error","_error":true,"_turn_id":"stream-123",
                 "_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"**Error:** boom","terminal_state":"error","expanded_by_default":true,"activity_rows":[{"row_id":"p","order_index":0,"role":"prose","text":"Partial work. "}]}}
              ]
            }
            """
        )
        streamClient.emit(.settledSession(settled))
        streamClient.emit(.error("boom"))

        let assistant = try XCTUnwrap(viewModel.messages.last(where: { $0.role == "assistant" }))
        XCTAssertEqual(assistant.messageId, "assistant-error")
        XCTAssertEqual(assistant.activityScene?.terminalState, "error")
        XCTAssertEqual(assistant.activityScene?.expandedByDefault, true)
    }

    @MainActor
    func testComposerSteerShowsSendingStateBeforeServerAccepts() async throws {
        let streamClient = SpySSEStreamingClient()
        let steerRequests = LockedCounter()
        let releaseSteer = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                _ = steerRequests.increment()
                releaseSteer.wait()
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        let submission = Task {
            await viewModel.submitStreamingMessage("Show the actual hint", behavior: .steer)
        }
        try await waitUntil { steerRequests.count == 1 }

        XCTAssertEqual(viewModel.messages.last?.content, "Show the actual hint")
        XCTAssertEqual(viewModel.messages.last?.steeringHintState, .sending)

        releaseSteer.signal()
        let result = await submission.value
        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(viewModel.messages.last?.steeringHintState, .waiting)
    }

    @MainActor
    func testRepeatedComposerSteersStayOrderedAndSettleTogether() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First. "))
        let firstSteer = await viewModel.submitStreamingMessage("Use tests", behavior: .steer)
        XCTAssertEqual(firstSteer, .executed(message: nil))
        let firstSteerID = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerConsumed(SteeringStreamEvent(
            steerId: firstSteerID,
            text: "Use tests"
        )))
        streamClient.emit(.token("Second. "))
        let secondSteer = await viewModel.submitStreamingMessage("Keep it focused", behavior: .steer)
        XCTAssertEqual(secondSteer, .executed(message: nil))
        let secondSteerID = try XCTUnwrap(viewModel.messages.last(where: {
            $0.isLocalSteeringHint && $0.messageId != firstSteerID
        })?.messageId)
        streamClient.emit(.token("Third."))

        XCTAssertEqual(
            viewModel.messages.compactMap { $0.isLocalSteeringHint ? $0.content : nil },
            ["Use tests", "Keep it focused"]
        )
        XCTAssertEqual(
            viewModel.messages.filter(\.isLocalSteeringHint).map(\.steeringHintState),
            [.consumed, .waiting]
        )

        streamClient.emit(.steerConsumed(SteeringStreamEvent(
            steerId: secondSteerID,
            text: "Keep it focused"
        )))

        streamClient.emit(.done(DoneStreamEvent(session: nil)))
        XCTAssertEqual(
            viewModel.messages.filter(\.isLocalSteeringHint).map(\.steeringHintState),
            [.consumed, .consumed]
        )
    }

    @MainActor
    func testSteerLeftoverBecomesOneNormalNextTurnMessage() async throws {
        let streamClient = SpySSEStreamingClient()
        var chatStartCount = 0
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                chatStartCount += 1
                return apiTestJSONResponse(
                    """
                    {"session_id":"session-abc","stream_id":"stream-\(chatStartCount)"}
                    """,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-1"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        _ = await viewModel.submitStreamingMessage("Run the focused test", behavior: .steer)
        let steerID = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.pendingSteerLeftover(SteeringStreamEvent(
            steerId: steerID,
            text: "Run the focused test"
        )))

        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))

        streamClient.emit(.streamEnd)
        try await waitUntil { chatStartCount == 2 }
        XCTAssertEqual(
            viewModel.messages.filter { $0.content == "Run the focused test" }.count,
            1
        )
        XCTAssertNil(viewModel.messages.last?.steeringHintState)
    }

    @MainActor
    func testCancellationRemovesUnresolvedSteeringHint() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/cancel":
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/session":
                // The server settled the cancelled turn before answering the cancel.
                return apiTestJSONResponse(
                    #"{"session":{"session_id":"session-abc","messages":[{"role":"user","content":"Initial request","message_id":"user-1","_turn_id":"stream-123"},{"role":"assistant","content":"","message_id":"assistant-cancelled","_error":true,"_terminal_state":"cancelled","_turn_id":"stream-123","_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"","terminal_state":"cancelled","activity_rows":[]}}]}}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        _ = await viewModel.submitStreamingMessage("Do not leave this stale", behavior: .steer)
        XCTAssertTrue(viewModel.messages.contains(where: \.isLocalSteeringHint))

        let didCancel = await viewModel.cancelActiveStream()
        XCTAssertTrue(didCancel)
        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
        // The stopped live view gives way to the server's settled turn.
        XCTAssertEqual(viewModel.messages.last?.activityScene?.terminalState, "cancelled")
    }

    @MainActor
    func testReconnectSnapshotKeepsPendingSteeringHintInOrder() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/session":
                return apiTestJSONResponse(
                    """
                    {
                      "session": {
                        "session_id": "session-abc",
                        "active_stream_id": "stream-123",
                        "messages": [
                          {"role":"user","content":"Initial request","message_id":"user-1"},
                          {"role":"assistant","content":"Before hint. ","message_id":"assistant-server"}
                        ]
                      }
                    }
                    """,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Before hint. "))
        _ = await viewModel.submitStreamingMessage("Keep this after reconnect", behavior: .steer)
        viewModel.suspendStreamForNavigation()

        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertNil(viewModel.streamingAssistantMessageID)
        XCTAssertEqual(
            viewModel.messages.map(\.content),
            ["Initial request", "Before hint. ", "Keep this after reconnect"]
        )
        XCTAssertEqual(viewModel.messages.last?.steeringHintState, .waiting)
    }

    @MainActor
    func testReconnectSnapshotKeepsConsumedSteerTheServerAlreadySaved() async throws {
        final class SteerIDBox: @unchecked Sendable { var value = "" }
        let steerID = SteerIDBox()
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id":"session-abc","stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/chat/steer":
                return apiTestJSONResponse(
                    #"{"accepted":true,"stream_id":"stream-123"}"#,
                    for: request
                )
            case "/api/session":
                // Mid-turn: the server saved the steer as it entered the stream, as a hidden row.
                return apiTestJSONResponse(
                    """
                    {
                      "session": {
                        "session_id": "session-abc",
                        "active_stream_id": "stream-123",
                        "messages": [
                          {"role":"user","content":"Initial request","message_id":"user-1","_turn_id":"stream-123"},
                          {"role":"user","content":"Keep this live","_turn_id":"stream-123","_steer":{"steer_id":"\(steerID.value)","submitted_at":3,"consumed_at":4,"phase_duration":4}},
                          {"role":"assistant","content":"Before hint. ","message_id":"assistant-server","_turn_id":"stream-123"}
                        ]
                      }
                    }
                    """,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Before hint. "))
        _ = await viewModel.submitStreamingMessage("Keep this live", behavior: .steer)
        steerID.value = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerConsumed(SteeringStreamEvent(steerId: steerID.value, text: "Keep this live")))
        viewModel.suspendStreamForNavigation()

        await viewModel.loadMessages()

        // The server row stays hidden until the turn's scene arrives; the live hint keeps rendering the steer.
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        let hints = viewModel.messages.filter(\.isLocalSteeringHint)
        XCTAssertEqual(hints.map(\.content), ["Keep this live"])
        XCTAssertEqual(hints.first?.steeringHintState, .consumed)
    }

    /// Issue #202: a queued slash message whose send fails must not be retried in a tight loop.
    /// This is the verify-first verdict test — it queues one message behind a live stream, makes
    /// every drained send fail, triggers the drain, and counts how many times the send is retried.
    /// A failure-driven retry loop shows up as more than one drained attempt; the guard makes it 1.
    @MainActor
    func testQueuedSlashMessageFailureDoesNotRetryInTightLoop() async throws {
        let streamClient = SpySSEStreamingClient()
        var startChatAttempts = 0
        // The first /api/chat/start establishes a live stream so the next slash message queues
        // behind it. Every drained send after that fails (no stream_id). The forced success at
        // attempt 7 is a safety escape hatch: it guarantees even a buggy retry loop terminates
        // (a successful send clears activeStreamID's nil guard / empties the queue), so the test
        // can never hang regardless of whether the loop exists.
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                startChatAttempts += 1
                if startChatAttempts == 1 || startChatAttempts >= 7 {
                    return apiTestJSONResponse(
                        #"{"session_id": "session-abc", "stream_id": "stream-123"}"#,
                        for: request
                    )
                }
                return apiTestJSONResponse(
                    #"{"session_id": "session-abc", "error": "server unreachable"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        // 1. Establish a live stream so the queued message has something to wait behind.
        let didStart = await viewModel.sendMessage("first message")
        XCTAssertTrue(didStart)
        XCTAssertNotNil(viewModel.activeStreamID)

        // 2. Queue one slash message behind the active stream.
        let queueCommand = try XCTUnwrap(SlashCommandCatalog.command(named: "queue"))
        let queued = await viewModel.executeSlashCommand(queueCommand, args: "retry-me")
        XCTAssertEqual(queued, .executed(message: "Queued for next turn (#1)."))

        let attemptsBeforeDrain = startChatAttempts // only the establishing send so far

        // 3. Finishing the stream is the natural drain trigger. The drained send fails persistently.
        streamClient.emit(.streamEnd)
        XCTAssertNil(viewModel.activeStreamID)

        // 4. Wait for the drained send itself, then let any retry loop quiesce. MockURLProtocol
        //    resolves synchronously, so once the attempt count is stable across several short polls
        //    no further sends are in flight. Without the first wait, a starved drain could look
        //    quiescent before it sent anything.
        try await waitUntil { startChatAttempts > attemptsBeforeDrain }
        var lastSeen = startChatAttempts
        var stablePolls = 0
        for _ in 0..<80 {
            try await Task.sleep(nanoseconds: 50_000_000)
            if startChatAttempts == lastSeen {
                stablePolls += 1
                if stablePolls >= 3 { break }
            } else {
                stablePolls = 0
                lastSeen = startChatAttempts
            }
        }

        let drainedAttempts = startChatAttempts - attemptsBeforeDrain

        // The guard makes a failed queued send attempt exactly once — no tight retry loop.
        XCTAssertEqual(
            drainedAttempts,
            1,
            "A failed queued send should be attempted exactly once, not retried in a loop. "
                + "Observed \(drainedAttempts) drained attempt(s)."
        )
        // The message remains queued for a later natural trigger instead of being dropped.
        let status = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "status")))
        guard case let .executed(message) = status, let statusText = message else {
            return XCTFail("Expected /status to return an executed message, got \(status).")
        }
        XCTAssertTrue(
            statusText.contains("Queued messages: 1"),
            "The failed queued message should still be queued. Status was:\n\(statusText)"
        )
    }

    @MainActor
    func testSuccessfulQueuedSendDeletesItsDurableDraftCopy() async throws {
        let streamClient = SpySSEStreamingClient()
        let attachmentStore = RecordingSendDraftAttachmentStore()
        var chatStartCount = 0
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            draftAttachmentStore: attachmentStore
        ) { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "notes.txt",
                  "path": "/tmp/workspace/notes.txt",
                  "size": 5,
                  "mime": "text/plain",
                  "is_image": false
                }
                """, for: request)
            case "/api/chat/start":
                chatStartCount += 1
                return apiTestJSONResponse(
                    """
                    {"session_id":"session-abc","stream_id":"stream-\(chatStartCount)"}
                    """,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStartFirstMessage = await viewModel.sendMessage("first message")
        XCTAssertTrue(didStartFirstMessage)
        await viewModel.uploadAttachment(data: Data("notes".utf8), filename: "notes.txt")
        let queueCommand = try XCTUnwrap(SlashCommandCatalog.command(named: "queue"))
        let queued = await viewModel.executeSlashCommand(queueCommand, args: "queued message")
        XCTAssertEqual(queued, .executed(message: "Queued for next turn (#1)."))

        streamClient.emit(.streamEnd)
        try await waitUntil { chatStartCount == 2 }
        let deletedNames = await attachmentStore.deletedNames()

        XCTAssertEqual(deletedNames, ["saved-1-notes.txt"])
    }

    /// Lets a `Task { @MainActor … }` enqueued by a delegate callback run to completion
    /// before assertions. Same-actor tasks run FIFO, so awaiting a task enqueued *after*
    /// the callback's drains it; the leading yields add slack.

    @MainActor
    func testQueuedSlashMessageDrainsAfterAFailedVoiceNoteReleasesThePipeline() async throws {
        let streamClient = SpySSEStreamingClient()
        // Hold transcription open so the voice note still owns the send pipeline
        // when the active stream ends and fires the drain trigger.
        let transcribeGate = DispatchSemaphore(value: 0)
        defer { transcribeGate.signal() }
        var chatStartCount = 0

        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                chatStartCount += 1
                return apiTestJSONResponse(
                    """
                    {"session_id":"session-abc","stream_id":"stream-\(chatStartCount)"}
                    """,
                    for: request
                )
            case "/api/transcribe":
                transcribeGate.wait()
                return apiTestJSONResponse(
                    #"{"ok": false, "error": "transcription unavailable"}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("first message")
        XCTAssertTrue(didStart)
        XCTAssertEqual(chatStartCount, 1)

        let queueCommand = try XCTUnwrap(SlashCommandCatalog.command(named: "queue"))
        let queued = await viewModel.executeSlashCommand(queueCommand, args: "queued message")
        XCTAssertEqual(queued, .executed(message: "Queued for next turn (#1)."))

        let voiceSend = Task { @MainActor in
            await viewModel.sendVoiceNote(audioData: Data("fake-m4a-bytes".utf8), filename: "voice-note.m4a")
        }
        try await waitUntil { viewModel.isSendingVoiceNote }

        // Stream completion is the drain trigger, but the voice note owns the send
        // pipeline, so the queued message must stay queued instead of burning its
        // single attempt on a send that `sendMessage` would reject.
        streamClient.emit(.streamEnd)
        XCTAssertNil(viewModel.activeStreamID)
        await drainMainActor()
        XCTAssertEqual(chatStartCount, 1)

        // The voice note fails without starting a stream, so releasing the pipeline
        // is the queued message's only remaining trigger.
        transcribeGate.signal()
        let didSendVoice = await voiceSend.value
        XCTAssertFalse(didSendVoice)

        try await waitUntil { chatStartCount == 2 }
        XCTAssertEqual(chatStartCount, 2)

        let status = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "status")))
        guard case let .executed(message) = status, let statusText = message else {
            return XCTFail("Expected /status to return an executed message, got \(status).")
        }
        XCTAssertTrue(
            statusText.contains("Queued messages: 0"),
            "The queued message should have drained once the voice note released the pipeline. Status was:\n\(statusText)"
        )
    }
}

/// Long completed turns arrive as a tail preview; the app pages the omitted rows like Web's history control.
extension ChatViewModelSendTests {
    @MainActor
    func testLoadEarlierSceneRowsPagesTheOmittedRowsOldestFirst() async throws {
        var requests: [URLComponents] = []
        let viewModel = try makeViewModel { request in
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            requests.append(components)
            XCTAssertEqual(components.path, "/api/session/anchor-scene")
            let before = components.queryItems?.first { $0.name == "before" }?.value
            // Two short pages, as a server with a small page size would send them (row kinds alternate as in a real turn).
            let body = before == "3"
                ? #"{"scene_ref":"ref","start":1,"end":3,"total":5,"complete":false,"rows":[{"row_id":"r1","order_index":1,"role":"prose","text":"Second"},{"row_id":"r2","order_index":2,"role":"reasoning","text":"Third"}]}"#
                : #"{"scene_ref":"ref","start":0,"end":1,"total":5,"complete":true,"rows":[{"row_id":"r0","order_index":0,"role":"reasoning","text":"First"},"malformed"]}"#
            return apiTestJSONResponse(body, for: request)
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let message = try decoder.decode(ChatMessage.self, from: Data(#"""
        {"role":"assistant","content":"Done.","message_id":"assistant-long","_turn_id":"run-1","_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"Done.","activity_rows_offset":3,"activity_scene_ref":"ref","activity_rows":[{"row_id":"r3","order_index":3,"role":"prose","text":"Fourth"},{"row_id":"r4","order_index":4,"role":"reasoning","text":"Fifth"}]}}
        """#.utf8))
        let transcriptMessage = TranscriptMessage(
            loadedIndex: 7,
            renderID: "transcript:7",
            anchorID: "assistant-long",
            message: message,
            assistantSegments: [TranscriptAssistantSegment(anchorID: "assistant-long", message: message)]
        )

        await viewModel.loadEarlierSceneRows(for: transcriptMessage)

        let earlier = viewModel.earlierSceneRows(for: transcriptMessage)
        XCTAssertEqual(earlier.map(\.rowID), ["r0", "r1", "r2"])
        XCTAssertEqual(requests.map { $0.queryItems?.first { $0.name == "before" }?.value }, ["3", "1"])
        XCTAssertEqual(requests.first?.queryItems?.first { $0.name == "message_ref" }?.value, "ref")
        XCTAssertEqual(requests.first?.queryItems?.first { $0.name == "session_id" }?.value, "session-abc")
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message, earlierRows: earlier))
        XCTAssertEqual(timeline.rows.compactMap(\.text), ["First", "Second", "Third", "Fourth", "Fifth", "Done."])

        // A loaded turn is not fetched again.
        await viewModel.loadEarlierSceneRows(for: transcriptMessage)
        XCTAssertEqual(requests.count, 2)

        // A regenerated reply at the same position is a new server turn: it never shows the previous turn's rows.
        let regenerated = try decoder.decode(ChatMessage.self, from: Data(#"""
        {"role":"assistant","content":"Redone.","_turn_id":"run-2","_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"Redone.","activity_rows_offset":3,"activity_rows":[]}}
        """#.utf8))
        let regeneratedMessage = TranscriptMessage(
            loadedIndex: 7,
            renderID: "transcript:7",
            anchorID: "assistant-long",
            message: regenerated,
            assistantSegments: [TranscriptAssistantSegment(anchorID: "assistant-long", message: regenerated)]
        )
        XCTAssertTrue(viewModel.earlierSceneRows(for: regeneratedMessage).isEmpty)
    }
}
