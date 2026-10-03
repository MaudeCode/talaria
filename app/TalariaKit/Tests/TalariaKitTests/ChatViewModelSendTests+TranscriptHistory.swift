import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testDeduplicatedReasoningTextsRemovesIdenticalThinkingBodies() {
        let texts = ChatViewModel.deduplicatedReasoningTexts([
            "  **Reading workout profile**\nChecking the user's profile and workout log.  ",
            "\n**Reading workout profile**\nChecking the user's profile and workout log.\n",
            "Checking a different source.",
            "   "
        ])

        XCTAssertEqual(
            texts,
            [
                "**Reading workout profile**\nChecking the user's profile and workout log.",
                "Checking a different source."
            ]
        )
    }

    @MainActor
    func testCompletedResponseRefreshesGeneratedSessionTitle() async throws {
        let streamClient = SpySSEStreamingClient()
        var didRefreshTitle = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            sessionSummary: makeSession(title: "Untitled Session")
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                XCTAssertEqual(query["messages"], "0")
                didRefreshTitle = true
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Generated Meal Plan"
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        XCTAssertEqual(viewModel.displayTitle, "Untitled Session")

        let didStart = await viewModel.sendMessage("Name this chat")
        XCTAssertTrue(didStart)
        streamClient.emit(.done(DoneStreamEvent()))
        streamClient.emit(.streamEnd)
        try await waitUntil {
            didRefreshTitle && viewModel.displayTitle == "Generated Meal Plan"
        }

        XCTAssertEqual(viewModel.displayTitle, "Generated Meal Plan")
    }

    @MainActor
    func testDoneUsageReplacesLiveResponseSpeedOnAssistantMessage() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didSend = await viewModel.sendMessage("Measure this")
        XCTAssertTrue(didSend)
        streamClient.emit(.token("Measured response."))
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 18.25,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        XCTAssertEqual(viewModel.liveTokensPerSecond, 18.25)

        streamClient.emit(.done(DoneStreamEvent(usage: ContextWindowSnapshot(
            contextUsedTokens: nil,
            contextWindowTokens: nil,
            contextUsagePercent: nil,
            thresholdTokens: nil,
            inputTokens: nil,
            outputTokens: nil,
            estimatedCost: nil,
            tokensPerSecond: 20.5,
            durationSeconds: 532
        ))))

        XCTAssertNil(viewModel.liveTokensPerSecond)
        let assistant = viewModel.messages.last(where: { $0.role == "assistant" })
        XCTAssertEqual(assistant?.turnTps, 20.5)
        XCTAssertEqual(assistant?.turnDuration, 532)
    }

    @MainActor
    func testDoneUsageAppliesResponseSpeedToLastAssistantInCompletedToolTurn() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didSend = await viewModel.sendMessage("Run a tool")
        XCTAssertTrue(didSend)
        streamClient.emit(.token("I'll inspect that."))
        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role":"user","content":"Run a tool"},
            {"role":"assistant","content":"I'll inspect that."},
            {"role":"tool","content":"Tool output"},
            {"role":"assistant","content":"Finished."}
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(
            usage: ContextWindowSnapshot(
                contextUsedTokens: nil,
                contextWindowTokens: nil,
                contextUsagePercent: nil,
                thresholdTokens: nil,
                inputTokens: nil,
                outputTokens: nil,
                estimatedCost: nil,
                tokensPerSecond: 20.5
            ),
            session: completedSession
        )))

        let assistantMessages = viewModel.messages.filter { $0.role == "assistant" }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertNil(assistantMessages.first?.turnTps)
        XCTAssertEqual(assistantMessages.last?.turnTps, 20.5)
        XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
    }

    @MainActor
    func testDoneUsageDoesNotOverwritePreviousAssistantWithoutCurrentStreamingAnchor() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didSend = await viewModel.sendMessage("Run a tool only")
        XCTAssertTrue(didSend)
        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role":"user","content":"Earlier question","messageId":"user-previous"},
            {"role":"assistant","content":"Earlier answer","messageId":"assistant-previous"},
            {"role":"user","content":"Run a tool only","messageId":"user-current"}
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(
            usage: ContextWindowSnapshot(
                contextUsedTokens: nil,
                contextWindowTokens: nil,
                contextUsagePercent: nil,
                thresholdTokens: nil,
                inputTokens: nil,
                outputTokens: nil,
                estimatedCost: nil,
                tokensPerSecond: 20.5
            ),
            session: completedSession
        )))

        XCTAssertNil(viewModel.messages.first(where: { $0.messageId == "assistant-previous" })?.turnTps)
        XCTAssertFalse(viewModel.messages.contains(where: { $0.turnTps != nil }))
    }

    @MainActor
    func testCompletedResponseCachesFinalTurnTpsWithoutTranscriptReload() async throws {
        let streamClient = SpySSEStreamingClient()
        let modelContext = try makeContext()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didSend = await viewModel.sendMessage("Measure this", modelContext: modelContext)
        XCTAssertTrue(didSend)
        streamClient.emit(.token("Measured response."))
        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role":"user","content":"Measure this","messageId":"user-current"},
            {"role":"assistant","content":"Measured response.","messageId":"assistant-server"}
          ]
        }
        """)
        streamClient.emit(.done(DoneStreamEvent(
            usage: ContextWindowSnapshot(
                contextUsedTokens: nil,
                contextWindowTokens: nil,
                contextUsagePercent: nil,
                thresholdTokens: nil,
                inputTokens: nil,
                outputTokens: nil,
                estimatedCost: nil,
                tokensPerSecond: 20.5
            ),
            session: completedSession
        )))

        XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
        viewModel.cacheCompletedResponse(modelContext: modelContext)

        let cachedMessages = try CacheStore.cachedMessages(
            serverURL: URL(string: "https://example.test")!,
            sessionID: "session-abc",
            in: modelContext
        )
        XCTAssertEqual(
            cachedMessages.first(where: { $0.messageId == "assistant-server" })?.turnTps,
            20.5
        )
    }

    @MainActor
    func testTransportErrorChecksStatusAndFinishesWhenStreamIsInactive() async throws {
        let streamClient = SpySSEStreamingClient()
        var didRequestStatus = false
        var didReloadMessages = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                didRequestStatus = true
                return apiTestJSONResponse("""
                {
                  "active": false,
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                didReloadMessages = true
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "messages": [
                      {
                        "role": "assistant",
                        "content": "Recovered transcript.",
                        "timestamp": 1770000100,
                        "message_id": "assistant-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")

        streamClient.emit(.transportError("The network connection was lost."))
        try await waitUntil {
            didRequestStatus && didReloadMessages
        }

        XCTAssertTrue(didRequestStatus)
        XCTAssertTrue(didReloadMessages)
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(viewModel.messages.map(\.content), ["Recovered transcript."])
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertEqual(streamClient.stopCount, 2)
    }

    @MainActor
    func testLoadMessagesReattachesActiveStreamFromReloadedSession() async throws {
        let streamClient = SpySSEStreamingClient()
        var didRequestStatus = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "active_stream_id": "stream-123",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      }
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/stream/status":
                didRequestStatus = true
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        XCTAssertTrue(didRequestStatus)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.startedURLs.first?.path, "/api/chat/stream")
    }

    @MainActor
    func testLoadMessagesDoesNotFailForWebUICreatedSessionDecodeDrift() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")

            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "WebUI-created",
                "messages": [
                  {
                    "role": "user",
                    "content": [
                      {"type": "text", "text": "Open this in mobile"}
                    ],
                    "_ts": "1770000000",
                    "message_id": 42
                  },
                  {
                    "role": "assistant",
                    "content": "Loaded",
                    "timestamp": 1770000001,
                    "tool_calls": {"unexpected": "shape"}
                  }
                ],
                "_messages_offset": "8"
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messagesOffset, 8)
        XCTAssertEqual(viewModel.messages.first?.messageId, "42")
        XCTAssertTrue(viewModel.messages.first?.content?.contains("Open this in mobile") == true)
    }

    @MainActor
    func testLoadMessagesTracksOlderHistoryAvailability() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")

            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "messages": [
                  {"role": "user", "content": "Recent question", "timestamp": 1, "message_id": "u-50"}
                ],
                "_messages_truncated": true,
                "_messages_offset": 50
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.messagesOffset, 50)
        XCTAssertTrue(viewModel.hasOlderMessages)
    }

    @MainActor
    func testLoadOlderMessagesUsesCurrentOffsetAndPrependsWithoutDuplicates() async throws {
        var requestQueries: [[String: String]] = []
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            requestQueries.append(query)

            switch query["msg_before"] {
            case nil:
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "read_only": true,
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            case "2":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Older question", "timestamp": 1, "message_id": "u-0"},
                      {"role": "assistant", "content": "Older answer", "timestamp": 2, "message_id": "a-1"},
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"}
                    ],
                    "read_only": false,
                    "_messages_truncated": false,
                    "_messages_offset": 0
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected query: \(query)")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let didLoadOlder = await viewModel.loadOlderMessages()

        XCTAssertTrue(didLoadOlder)
        XCTAssertEqual(requestQueries.count, 2)
        XCTAssertNil(requestQueries[0]["msg_before"])
        XCTAssertEqual(requestQueries[1]["msg_before"], "2")
        XCTAssertEqual(requestQueries[1]["msg_limit"], "50")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Older question",
            "Older answer",
            "Recent question",
            "Recent answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 0)
        XCTAssertFalse(viewModel.hasOlderMessages)
        // Pagination runs outside session-load arbitration (TAL-152), so its
        // payload must not relax the read-only state the cold load applied.
        XCTAssertTrue(viewModel.isSessionReadOnly)
    }

    @MainActor
    func testLoadOlderMessagesFallbackOffsetUsesMergedTranscriptCount() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })

            switch query["msg_before"] {
            case nil:
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 5, "message_id": "u-4"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 6, "message_id": "a-5"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 4
                  }
                }
                """, for: request)
            case "4":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "message_count": 6,
                    "messages": [
                      {"role": "user", "content": "Middle question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Middle answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected query: \(query)")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let didLoadOlder = await viewModel.loadOlderMessages()

        XCTAssertTrue(didLoadOlder)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Middle question",
            "Middle answer",
            "Recent question",
            "Recent answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 2)
        XCTAssertTrue(viewModel.hasOlderMessages)
    }

    @MainActor
    func testLoadMessagesPreservesExpandedTranscriptWhenReloadReturnsLatestWindow() async throws {
        var latestLoadCount = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })

            switch query["msg_before"] {
            case nil:
                latestLoadCount += 1
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            case "2":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Older question", "timestamp": 1, "message_id": "u-0"},
                      {"role": "assistant", "content": "Older answer", "timestamp": 2, "message_id": "a-1"}
                    ],
                    "_messages_truncated": false,
                    "_messages_offset": 0
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected query: \(query)")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let didLoadOlder = await viewModel.loadOlderMessages()
        await viewModel.loadMessages()

        XCTAssertTrue(didLoadOlder)
        XCTAssertEqual(latestLoadCount, 2)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Older question",
            "Older answer",
            "Recent question",
            "Recent answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 0)
        XCTAssertFalse(viewModel.hasOlderMessages)
    }

    @MainActor
    func testCompletedStreamSessionPreservesExpandedTranscriptWhenDoneReturnsLatestWindow() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })

                if query["msg_before"] == "2" {
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "messages": [
                          {"role": "user", "content": "Older question", "timestamp": 1, "message_id": "u-0"},
                          {"role": "assistant", "content": "Older answer", "timestamp": 2, "message_id": "a-1"}
                        ],
                        "_messages_truncated": false,
                        "_messages_offset": 0
                      }
                    }
                    """, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            case "/api/chat/start":
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

        await viewModel.loadMessages()
        let didLoadOlder = await viewModel.loadOlderMessages()
        let didStart = await viewModel.sendMessage("Newest question")
        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role": "user", "content": "Recent question", "message_id": "u-2"},
            {"role": "assistant", "content": "Recent answer", "message_id": "a-3"},
            {"role": "user", "content": "Newest question", "message_id": "u-4"},
            {"role": "assistant", "content": "Newest answer", "message_id": "a-5"}
          ],
          "_messages_truncated": true,
          "_messages_offset": 2
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertTrue(didLoadOlder)
        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Older question",
            "Older answer",
            "Recent question",
            "Recent answer",
            "Newest question",
            "Newest answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 0)
        XCTAssertFalse(viewModel.hasOlderMessages)
        XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
    }

    @MainActor
    func testCompletedStreamSessionKeepsCurrentOffsetWhenDoneReturnsWidenedWindow() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            case "/api/chat/start":
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

        await viewModel.loadMessages()
        let didStart = await viewModel.sendMessage("Newest question")
        // `.done` widens the window all the way back to the session start
        // (offset 0). The rows already on screen must keep their positional
        // renderIDs, so the current offset wins and the widened head is trimmed.
        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role": "user", "content": "Older question", "message_id": "u-0"},
            {"role": "assistant", "content": "Older answer", "message_id": "a-1"},
            {"role": "user", "content": "Recent question", "message_id": "u-2"},
            {"role": "assistant", "content": "Recent answer", "message_id": "a-3"},
            {"role": "user", "content": "Newest question", "message_id": "u-4"},
            {"role": "assistant", "content": "Newest answer", "message_id": "a-5"}
          ],
          "_messages_truncated": false,
          "_messages_offset": 0
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Recent question",
            "Recent answer",
            "Newest question",
            "Newest answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 2)
        XCTAssertTrue(viewModel.hasOlderMessages)
        XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
    }

    @MainActor
    func testCompletedStreamSessionKeepsCurrentOffsetWhenDoneOmitsOffset() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            case "/api/chat/start":
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

        await viewModel.loadMessages()
        let didStart = await viewModel.sendMessage("Newest question")
        // `.done` without `_messages_offset` used to resolve to offset 0 and
        // renumber every on-screen row. The overlap trim must keep offset 2.
        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role": "user", "content": "Older question", "message_id": "u-0"},
            {"role": "assistant", "content": "Older answer", "message_id": "a-1"},
            {"role": "user", "content": "Recent question", "message_id": "u-2"},
            {"role": "assistant", "content": "Recent answer", "message_id": "a-3"},
            {"role": "user", "content": "Newest question", "message_id": "u-4"},
            {"role": "assistant", "content": "Newest answer", "message_id": "a-5"}
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Recent question",
            "Recent answer",
            "Newest question",
            "Newest answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 2)
        XCTAssertTrue(viewModel.hasOlderMessages)
        XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
    }

    @MainActor
    func testReloadWithoutOverlapStillReplacesTranscript() async throws {
        var sessionRequestCount = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            sessionRequestCount += 1
            if sessionRequestCount == 1 {
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            }

            // Truncation/compaction rewrote history: no overlap with the
            // on-screen window, so the reload must fully replace it.
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "messages": [
                  {"role": "user", "content": "Rewritten question", "timestamp": 5, "message_id": "u-9"},
                  {"role": "assistant", "content": "Rewritten answer", "timestamp": 6, "message_id": "a-10"}
                ],
                "_messages_truncated": false,
                "_messages_offset": 0
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages()
        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Rewritten question",
            "Rewritten answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 0)
        XCTAssertFalse(viewModel.hasOlderMessages)
    }

    @MainActor
    func testReloadWithMisalignedOverlapStillReplacesTranscript() async throws {
        var sessionRequestCount = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            sessionRequestCount += 1
            if sessionRequestCount == 1 {
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                      {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            }

            // A rewrite retained the first on-screen message but moved it to a
            // different absolute index. Preserving offset 2 would make both row
            // identity and destructive action keep-counts incorrect.
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "messages": [
                  {"role": "assistant", "content": "Compacted context", "timestamp": 2, "message_id": "a-1"},
                  {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"},
                  {"role": "assistant", "content": "Recent answer", "timestamp": 4, "message_id": "a-3"}
                ],
                "_messages_truncated": false,
                "_messages_offset": 0
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages()
        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Compacted context",
            "Recent question",
            "Recent answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 0)
        XCTAssertFalse(viewModel.hasOlderMessages)
    }

    @MainActor
    func testReloadUsesExpectedOverlapWhenFallbackMessageIDsRepeat() async throws {
        var sessionRequestCount = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            sessionRequestCount += 1
            if sessionRequestCount == 1 {
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Repeated question"},
                      {"role": "assistant", "content": "Recent answer", "message_id": "a-3"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 2
                  }
                }
                """, for: request)
            }

            // The first and third messages intentionally share ChatMessage's
            // fallback ID. The offset delta identifies index 2 as the real
            // overlap; firstIndex would incorrectly choose index 0.
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "messages": [
                  {"role": "user", "content": "Repeated question"},
                  {"role": "assistant", "content": "Older answer", "message_id": "a-1"},
                  {"role": "user", "content": "Repeated question"},
                  {"role": "assistant", "content": "Recent answer", "message_id": "a-3"}
                ],
                "_messages_truncated": false,
                "_messages_offset": 0
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages()
        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Repeated question",
            "Recent answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 2)
        XCTAssertTrue(viewModel.hasOlderMessages)
    }

    @MainActor
    func testLoadOlderMessagesKeepsAffordanceWhenAnotherOlderPageExists() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })

            if query["msg_before"] == nil {
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "messages": [
                      {"role": "user", "content": "Tail", "timestamp": 51, "message_id": "u-50"}
                    ],
                    "_messages_truncated": true,
                    "_messages_offset": 50
                  }
                }
                """, for: request)
            }

            XCTAssertEqual(query["msg_before"], "50")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "messages": [
                  {"role": "assistant", "content": "Earlier page", "timestamp": 50, "message_id": "a-49"}
                ],
                "_messages_truncated": true,
                "_messages_offset": 49
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages()
        let didLoadOlder = await viewModel.loadOlderMessages()

        XCTAssertTrue(didLoadOlder)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Earlier page", "Tail"])
        XCTAssertEqual(viewModel.messagesOffset, 49)
        XCTAssertTrue(viewModel.hasOlderMessages)
    }

    // MARK: - TAL-117: pagination keeps received-but-unrendered stream content

    private enum OlderPageOutcome {
        case success
        case empty
        case failure
    }

    /// Latest window: one recent message with an older page behind it. `/api/chat/start`
    /// begins a stream so the test can buffer SSE content before paginating.
    private static func paginatedStreamingSessionHandler(
        olderPage: OlderPageOutcome
    ) -> (URLRequest) throws -> (HTTPURLResponse, Data) {
        { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                guard query["msg_before"] == "2" else {
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "messages": [
                          {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"}
                        ],
                        "_messages_truncated": true,
                        "_messages_offset": 2
                      }
                    }
                    """, for: request)
                }
                switch olderPage {
                case .success:
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "messages": [
                          {"role": "user", "content": "Old question", "timestamp": 1, "message_id": "u-0"},
                          {"role": "assistant", "content": "Old answer", "timestamp": 2, "message_id": "a-1"},
                          {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"}
                        ],
                        "_messages_truncated": false,
                        "_messages_offset": 0
                      }
                    }
                    """, for: request)
                case .empty:
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "messages": [],
                        "_messages_truncated": false,
                        "_messages_offset": 0
                      }
                    }
                    """, for: request)
                case .failure:
                    throw URLError(.timedOut)
                }
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
    }

    /// Stream client that never auto-flushes, paired with a coalescing delay far
    /// longer than the test, so emitted content stays in the pending buffers until
    /// production code flushes it.
    private func makePendingContentViewModel(
        olderPage: OlderPageOutcome
    ) async throws -> (ChatViewModel, SpySSEStreamingClient) {
        let streamClient = SpySSEStreamingClient()
        streamClient.automaticallyFlushPendingStreamingContent = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            streamingScrollCoalescingDelayNanoseconds: 60_000_000_000,
            handler: Self.paginatedStreamingSessionHandler(olderPage: olderPage)
        )

        await viewModel.loadMessages()
        XCTAssertTrue(viewModel.hasOlderMessages)
        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        return (viewModel, streamClient)
    }

    func testLoadOlderMessagesFlushesPendingAssistantTextBeforePrepend() async throws {
        let (viewModel, streamClient) = try await makePendingContentViewModel(olderPage: .success)

        streamClient.emit(.token("Partial "))
        streamClient.emit(.token("answer"))
        XCTAssertEqual(viewModel.messages.last?.content, "", "token must still be pending before pagination")

        let didLoadOlder = await viewModel.loadOlderMessages()

        XCTAssertTrue(didLoadOlder)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Old question",
            "Old answer",
            "Recent question",
            "Keep working",
            "Partial answer"
        ])
        XCTAssertEqual(viewModel.messagesOffset, 0)

        // The stream continues into the same row without repeating flushed text.
        streamClient.emit(.token(" done."))
        viewModel.flushPendingStreamingContent()
        XCTAssertEqual(viewModel.messages.last?.content, "Partial answer done.")
    }

    func testLoadOlderMessagesEmptyPageKeepsPendingReasoningAndTitles() async throws {
        let (viewModel, streamClient) = try await makePendingContentViewModel(olderPage: .empty)

        streamClient.emit(.reasoning(ReasoningStreamEvent(
            text: "Plan the fix.",
            titles: ["Planning"]
        )))
        XCTAssertEqual(viewModel.liveReasoningText, "", "reasoning must still be pending before pagination")

        let didLoadOlder = await viewModel.loadOlderMessages()

        XCTAssertFalse(didLoadOlder)
        XCTAssertEqual(viewModel.liveReasoningText, "Plan the fix.")
        guard case .reasoning(let reasoning) = viewModel.liveActivityRows.first?.content else {
            return XCTFail("Expected live reasoning after pagination")
        }
        XCTAssertEqual(reasoning.titles, ["Planning"])
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Recent question", "Keep working", ""])

        streamClient.emit(.reasoning(ReasoningStreamEvent(text: " Then verify.", titles: [])))
        viewModel.flushPendingStreamingContent()
        XCTAssertEqual(viewModel.liveReasoningText, "Plan the fix. Then verify.")
    }

    func testLoadOlderMessagesFailureKeepsFlushedAssistantText() async throws {
        let (viewModel, streamClient) = try await makePendingContentViewModel(olderPage: .failure)

        streamClient.emit(.token("Partial answer"))
        XCTAssertEqual(viewModel.messages.last?.content, "")

        let didLoadOlder = await viewModel.loadOlderMessages()

        XCTAssertFalse(didLoadOlder)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.hasOlderMessages)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Recent question", "Keep working", "Partial answer"])

        streamClient.emit(.token(" done."))
        viewModel.flushPendingStreamingContent()
        XCTAssertEqual(viewModel.messages.last?.content, "Partial answer done.")
    }
}
