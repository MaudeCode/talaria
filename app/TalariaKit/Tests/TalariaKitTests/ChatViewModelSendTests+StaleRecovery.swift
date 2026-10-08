import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testSendMessageRollsBackOptimisticMessageWhenStartThrows() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "photo.png",
                  "path": "/tmp/workspace/photo.png",
                  "size": 4,
                  "mime": "image/png",
                  "is_image": true
                }
                """, for: request)
            case "/api/chat/start":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"server unavailable"}"#.utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(
            data: Data([0x00, 0x01, 0x02, 0x03]),
            filename: "photo.png",
            previewData: Data([0x99])
        )

        let didStart = await viewModel.sendMessage("Summarize it")

        XCTAssertFalse(didStart)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertTrue(viewModel.localAttachmentPreviews.isEmpty)
        XCTAssertEqual(viewModel.pendingAttachments.count, 1)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertNotNil(viewModel.sendErrorMessage)
    }

    @MainActor
    func testTransportErrorChecksStatusAndReattachesWhenStreamIsActive() async throws {
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
                  "active": true,
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
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)

        streamClient.emit(.transportError("The network connection was lost."))
        try await waitUntil {
            didRequestStatus && didReloadMessages && streamClient.startedURLs.count == 2
        }

        XCTAssertTrue(didRequestStatus)
        XCTAssertTrue(didReloadMessages)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertEqual(streamClient.startedURLs.last?.path, "/api/chat/stream")
    }

    @MainActor
    func testReconnectAfterBackgroundRefreshesTranscriptBeforeReattachingActiveStream() async throws {
        let streamClient = SpySSEStreamingClient()
        var didRequestStatus = false
        var didReloadMessages = false
        let now = serverNow
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
                  "active": true,
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
                    "active_stream_id": "stream-123",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": \(now),
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "First middle ",
                        "timestamp": \(now + 1),
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
        streamClient.emit(.token("First "))
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First "])

        viewModel.suspendStreamForBackground()
        await viewModel.reconnectStreamIfNeeded()
        streamClient.emit(.token("last."))

        XCTAssertTrue(didRequestStatus)
        XCTAssertTrue(didReloadMessages)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First middle last."])
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 1)
    }

    @MainActor
    func testContextlessReloadKeepsRepeatedPromptOverOlderIdenticalTurn() async throws {
        let earlier = serverNow - 3_600
        let userRows = try await contextlessRepeatReload(showsEarlierTurn: false, earlierTurn: """
            {"role": "user", "content": "continue", "timestamp": \(earlier), "message_id": "user-1"},
            {"role": "assistant", "content": "Earlier answer.", "timestamp": \(earlier + 1), "message_id": "assistant-1"}
            """)
        XCTAssertEqual(userRows.map { $0.messageId?.prefix(6) }, ["user-1", "local-"])
    }

    // A quick repeat sits inside the recency window, so only the turn it follows tells the two prompts apart.
    @MainActor
    func testContextlessReloadKeepsQuicklyRepeatedPromptAfterTheTurnItFollows() async throws {
        let earlier = serverNow - 10
        let userRows = try await contextlessRepeatReload(earlierTurn: """
            {"role": "user", "content": "continue", "timestamp": \(earlier), "message_id": "user-1"},
            {"role": "assistant", "content": "Earlier answer.", "timestamp": \(earlier + 1), "message_id": "assistant-1"}
            """)
        XCTAssertEqual(userRows.map { $0.messageId?.prefix(6) }, ["user-1", "local-"])
    }

    // An old server may send no `message_id`; the shown rows' own server timestamps still mark them.
    @MainActor
    func testContextlessReloadKeepsQuicklyRepeatedPromptWhenShownRowsHaveNoMessageID() async throws {
        let earlier = serverNow - 10
        let userRows = try await contextlessRepeatReload(earlierTurn: """
            {"role": "user", "content": "continue", "timestamp": \(earlier)},
            {"role": "assistant", "content": "Earlier answer.", "timestamp": \(earlier + 1)}
            """)
        XCTAssertEqual(userRows.map { $0.messageId?.prefix(6) }, [nil, "local-"])
    }

    // With neither a `message_id` nor a timestamp, the shown turn is matched by its place: it comes first.
    @MainActor
    func testContextlessReloadKeepsRepeatedPromptWhenShownRowsHaveNoStableKey() async throws {
        let userRows = try await contextlessRepeatReload(earlierTurn: """
            {"role": "user", "content": "continue"},
            {"role": "assistant", "content": "Earlier answer."}
            """)
        XCTAssertEqual(userRows.map { $0.messageId?.prefix(6) }, [nil, "local-"])
    }

    @MainActor
    func testContextlessReloadReplacesQuicklyRepeatedPromptWithTheServersCopy() async throws {
        let earlier = serverNow - 10
        let userRows = try await contextlessRepeatReload(
            earlierTurn: """
            {"role": "user", "content": "continue", "timestamp": \(earlier), "message_id": "user-1"},
            {"role": "assistant", "content": "Earlier answer.", "timestamp": \(earlier + 1), "message_id": "assistant-1"}
            """,
            runningTurn: #"{"role": "user", "content": "continue", "timestamp": \#(serverNow), "message_id": "user-2"}"#
        )
        XCTAssertEqual(userRows.map(\.messageId), ["user-1", "user-2"])
    }

    // Current Web stamps the running prompt with the stream as its `_turn_id`: that identity, not the two clocks, decides.
    @MainActor
    func testContextlessReloadConfirmsTheRunningTurnsPromptAcrossServerClockSkew() async throws {
        let skewed = serverNow - 900
        let userRows = try await contextlessRepeatReload(
            earlierTurn: """
            {"role": "user", "content": "continue", "timestamp": \(skewed - 10), "_turn_id": "stream-old"},
            {"role": "assistant", "content": "Earlier answer.", "timestamp": \(skewed - 9), "_turn_id": "stream-old"}
            """,
            runningTurn: #"{"role": "user", "content": "continue", "timestamp": \#(skewed), "_turn_id": "stream-123"}"#
        )
        XCTAssertEqual(userRows.map(\.turnId), ["stream-old", "stream-123"])
    }

    @MainActor
    func testContextlessReloadKeepsRepeatedPromptThatOnlyAnEarlierTurnMatches() async throws {
        let earlier = serverNow - 10
        let userRows = try await contextlessRepeatReload(showsEarlierTurn: false, earlierTurn: """
            {"role": "user", "content": "continue", "timestamp": \(earlier), "_turn_id": "stream-old"},
            {"role": "assistant", "content": "Earlier answer.", "timestamp": \(earlier + 1), "_turn_id": "stream-old"}
            """)
        XCTAssertEqual(userRows.map(\.turnId), ["stream-old", nil])
        XCTAssertEqual(userRows.last?.messageId?.hasPrefix("local-"), true)
    }

    // The first prompt is still optimistic (its refresh failed), so it claims its own persisted copy first.
    @MainActor
    func testContextlessReloadKeepsRepeatedPromptAfterAnUnconfirmedEarlierPrompt() async throws {
        let streamClient = SpySSEStreamingClient()
        let earlier = serverNow - 10
        var startCount = 0
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                startCount += 1
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-\#(startCount)"}"#, for: request)
            case "/api/session" where startCount == 2:
                return apiTestJSONResponse("""
                {"session": {"session_id": "session-abc", "title": "Planning", "active_stream_id": "stream-2",
                  "messages": [
                    {"role": "user", "content": "continue", "timestamp": \(earlier), "message_id": "user-1"},
                    {"role": "assistant", "content": "Earlier answer.", "timestamp": \(earlier + 1), "message_id": "assistant-1"}
                  ]}}
                """, for: request)
            default:
                throw URLError(.notConnectedToInternet)
            }
        }

        let didStartFirst = await viewModel.sendMessage("continue")
        XCTAssertTrue(didStartFirst)
        streamClient.emit(.token("Earlier answer."))
        streamClient.emit(.streamEnd)
        try await waitUntil { viewModel.activeStreamID == nil }
        let didStartRepeat = await viewModel.sendMessage("continue")
        XCTAssertTrue(didStartRepeat)
        await viewModel.loadMessages()

        let userRows = viewModel.messages.filter { $0.role == "user" }
        XCTAssertEqual(userRows.map { $0.messageId?.prefix(6) }, ["user-1", "local-"])
    }

    /// Sends "continue" again after `earlierTurn` (shown first unless `showsEarlierTurn` is false), then reloads with
    /// no model context while the same stream still runs and the server holds `runningTurn` after that turn.
    /// Returns the reloaded user rows, after checking the earlier turn keeps its place.
    @MainActor
    private func contextlessRepeatReload(
        showsEarlierTurn: Bool = true,
        earlierTurn: String,
        runningTurn: String? = nil
    ) async throws -> [ChatMessage] {
        var hasStarted = false
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                hasStarted = true
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/session":
                let activeStream = hasStarted ? #""active_stream_id": "stream-123","# : ""
                let rows = [earlierTurn] + (hasStarted ? [runningTurn].compactMap { $0 } : [])
                return apiTestJSONResponse("""
                {"session": {"session_id": "session-abc", "title": "Planning", \(activeStream)
                  "messages": [\(rows.joined(separator: ","))]}}
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        if showsEarlierTurn {
            await viewModel.loadMessages()
            XCTAssertEqual(viewModel.messages.compactMap(\.content), ["continue", "Earlier answer."])
        }
        let didStart = await viewModel.sendMessage("continue")
        XCTAssertTrue(didStart)
        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.messages.prefix(3).compactMap(\.content), ["continue", "Earlier answer.", "continue"])
        return viewModel.messages.filter { $0.role == "user" }
    }

    @MainActor
    func testStaleActiveStreamShowsCheckingStateAndPollsStatus() async throws {
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
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

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .checking)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(requestPaths, ["/api/chat/start", "/api/chat/stream/status"])
    }

    @MainActor
    func testStaleActiveStreamKeepsLiveReasoningVisibleWhileChecking() async throws {
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
            case "/api/chat/stream/status":
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

        let didStart = await viewModel.sendMessage("Think through the plan")
        XCTAssertTrue(didStart)
        streamClient.emit(.reasoning("I need to inspect the workspace first."))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .checking)
        XCTAssertEqual(viewModel.liveReasoningText, "I need to inspect the workspace first.")
        XCTAssertNotNil(viewModel.streamingAssistantMessageID)
        XCTAssertEqual(viewModel.messages.compactMap(\.role), ["user", "assistant"])
    }

    @MainActor
    func testStaleActiveStreamDoesNotShowRecoveryStateBeforeFirstVisibleProgress() async throws {
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                XCTFail("Initial assistant wait should not poll stream status before visible progress.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(10))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(requestPaths, ["/api/chat/start"])
    }

    @MainActor
    func testStaleActiveStreamRefreshesCompletedTranscriptAndClearsActiveStream() async throws {
        let streamClient = SpySSEStreamingClient()
        var requestPaths: [String] = []
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": false,
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "Recovered full answer.",
                        "timestamp": 1770000101,
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
        streamClient.emit(.token("Partial "))

        // 13s: past transportFreshInterval (12), so stale recovery polls status
        // and finalizes the inactive run (#227).
        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "Recovered full answer."])
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(requestPaths, ["/api/chat/start", "/api/chat/stream/status", "/api/session"])
    }

    @MainActor
    func testStaleActiveStreamInactiveWithoutFinalAssistantStopsChecking() async throws {
        let streamClient = SpySSEStreamingClient()
        let liveActivityManager = SpyChatLiveActivityManager()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": false,
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
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
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Partial "))

        // 13s: past transportFreshInterval (12), so stale recovery polls status
        // and finalizes the inactive run (#227).
        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(liveActivityManager.ends, [
            SpyChatLiveActivityManager.End(
                status: .failed,
                activity: "Response failed",
                errorSummary: nil
            )
        ])
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "Partial "])
    }

    @MainActor
    func testStaleActiveStreamReconnectsWithReplayAndSkipsDuplicateTokens() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "), lastEventID: "stream-123:1")

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(uniqueKeysWithValues: queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["replay"], "1")
        XCTAssertEqual(query["after_seq"], "1")

        streamClient.emit(.token("First "), lastEventID: "stream-123:1")
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First "])

        streamClient.emit(.token("answer."), lastEventID: "stream-123:2")

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First answer."])
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 1)
    }

    @MainActor
    func testStaleActiveStreamReconnectsWithReplayFromBeginningBeforeAnyJournalEvent() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)

        // Nothing of the run is on screen, so the replay starts at its beginning.
        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(uniqueKeysWithValues: queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["replay"], "1")
        XCTAssertEqual(query["after_seq"], "0")

        streamClient.emit(.token("First "), lastEventID: "stream-123:1")
        streamClient.emit(.token("answer."), lastEventID: "stream-123:2")

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First answer."])
    }

    @MainActor
    func testStaleActiveStreamReconnectsWithoutReplayQueryWhenReplayUnavailable() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": false
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "), lastEventID: "stream-123:1")

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        XCTAssertEqual(streamClient.startedURLs.count, 2)
        let reconnectURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: reconnectURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "replay" })?.value)
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" })?.value)
    }

    @MainActor
    func testStaleActiveStreamStatusErrorOnlyReconnectsAfterForceThreshold() async throws {
        let streamClient = SpySSEStreamingClient()
        var statusRequestCount = 0
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
                statusRequestCount += 1
                throw URLError(.timedOut)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertEqual(statusRequestCount, 1)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .checking)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.stopCount, 0)

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        XCTAssertEqual(statusRequestCount, 2)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(uniqueKeysWithValues: queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["replay"], "1")
        XCTAssertEqual(query["after_seq"], "0")
    }

    @MainActor
    func testStaleActiveStreamStatusPollHonorsCooldown() async throws {
        let streamClient = SpySSEStreamingClient()
        var statusRequestCount = 0
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
                statusRequestCount += 1
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

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "))

        let firstPollDate = Date().addingTimeInterval(12.5)
        await viewModel.recoverStaleActiveStreamIfNeeded(now: firstPollDate)
        await viewModel.recoverStaleActiveStreamIfNeeded(now: firstPollDate.addingTimeInterval(2))
        await viewModel.recoverStaleActiveStreamIfNeeded(now: firstPollDate.addingTimeInterval(5))

        XCTAssertEqual(statusRequestCount, 2)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .checking)
    }

    @MainActor
    func testStaleActiveStreamDoesNotForceReconnectPlainSlowStreamAtTenSeconds() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(10))

        // #227: 10s of quiet is still inside transportFreshInterval, so the
        // slow-but-alive stream shows no recovery chip at all — and is
        // certainly not force-reconnected.
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testStaleActiveStreamReplayDuplicateOnlyConnectionCanRecoverAgain() async throws {
        let streamClient = SpySSEStreamingClient()
        var statusRequestCount = 0
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
                statusRequestCount += 1
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "), lastEventID: "stream-123:1")

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.token("First "), lastEventID: "stream-123:1")

        XCTAssertEqual(statusRequestCount, 1)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First "])

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertEqual(statusRequestCount, 2)
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .checking)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
    }

    @MainActor
    func testStaleActiveStreamReplayNeverReappliesMixedEventsItsCursorCovers() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        let startedTool = ToolStreamEvent(
            eventType: "tool.started",
            name: "run_command",
            preview: "Running tests",
            args: ["cmd": .string("xcodebuild test")],
            duration: nil,
            isError: nil,
            stableID: "call-run-command"
        )
        let completedTool = ToolStreamEvent(
            eventType: "tool.completed",
            name: "run_command",
            preview: "Passed tests",
            args: ["cmd": .string("xcodebuild test")],
            duration: 1.5,
            isError: false,
            stableID: "call-run-command"
        )

        let didStart = await viewModel.sendMessage("Inspect logs")
        XCTAssertTrue(didStart)
        let titleEvent = TitleStreamEvent(sessionId: "session-abc", title: "Inspect logs")
        streamClient.emit(.title(titleEvent))
        streamClient.emit(.token("Checking. "), lastEventID: "stream-123:1")
        streamClient.emit(.toolStarted(startedTool), lastEventID: "stream-123:2")
        streamClient.emit(.toolCompleted(completedTool), lastEventID: "stream-123:3")
        streamClient.emit(.reasoning("Plan."), lastEventID: "stream-123:4")

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.title(titleEvent))
        streamClient.emit(.token("Checking. "), lastEventID: "stream-123:1")
        streamClient.emit(.toolStarted(startedTool), lastEventID: "stream-123:2")
        streamClient.emit(.toolCompleted(completedTool), lastEventID: "stream-123:3")
        streamClient.emit(.reasoning("Plan."), lastEventID: "stream-123:4")

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Inspect logs", "Checking. "])
        XCTAssertEqual(viewModel.liveReasoningText, "Plan.")
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(viewModel.liveToolCalls.first?.name, "run_command")
        XCTAssertEqual(viewModel.liveToolCalls.first?.preview, "Passed tests")
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)

        streamClient.emit(.token("Checking. "), lastEventID: "stream-123:5")
        streamClient.emit(.toolStarted(startedTool), lastEventID: "stream-123:6")
        streamClient.emit(.toolCompleted(completedTool), lastEventID: "stream-123:7")

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Inspect logs", "Checking. Checking. "])
        XCTAssertEqual(viewModel.liveToolCalls.count, 2)
    }

    @MainActor
    func testReplayCompletesSecondSameNameToolByStableID() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run both checks")
        XCTAssertTrue(didStart)

        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "run_command",
            preview: "Running first check",
            args: ["cmd": .string("swift test")],
            duration: nil,
            isError: nil,
            stableID: "call-first"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool.completed",
            name: "run_command",
            preview: "First check passed",
            args: ["cmd": .string("swift test")],
            duration: 0.5,
            isError: false,
            stableID: "call-first"
        )))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "run_command",
            preview: "Running second check",
            args: ["cmd": .string("swift test")],
            duration: nil,
            isError: nil,
            stableID: "call-second"
        )))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool.completed",
            name: "run_command",
            preview: "Second check passed",
            args: ["cmd": .string("swift test")],
            duration: 0.75,
            isError: false,
            stableID: "call-second"
        )))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.liveToolCalls.count, 2)
        XCTAssertEqual(viewModel.liveToolCalls.map(\.id), ["call-first", "call-second"])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.preview), ["First check passed", "Second check passed"])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.isCompleted), [true, true])
    }

    @MainActor
    func testStaleActiveStreamDoesNotForceReconnectDuringRunningToolAtNormalThreshold() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Inspect logs")
        XCTAssertTrue(didStart)
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "run_command",
            preview: "Running tests",
            args: ["cmd": .string("xcodebuild test")],
            duration: nil,
            isError: nil
        )))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(13))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .checking)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, false)
    }

    @MainActor
    func testStaleActiveStreamForceReconnectsRunningToolAfterToolThreshold() async throws {
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
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Inspect logs")
        XCTAssertTrue(didStart)
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "run_command",
            preview: "Running tests",
            args: ["cmd": .string("xcodebuild test")],
            duration: nil,
            isError: nil
        )))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(26))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
    }

    @MainActor
    func testReopeningActiveStreamRestoresLiveSnapshotBeforeBufferedTailArrives() async throws {
        let originalStreamClient = SpySSEStreamingClient()
        let originalViewModel = try makeViewModel(streamClient: originalStreamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await originalViewModel.sendMessage("Tell me a tiger story")
        XCTAssertTrue(didStart)

        originalStreamClient.emit(.reasoning("Planning the tiger story."))
        originalStreamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "read_file",
            preview: "Reading jungle notes",
            args: ["path": .string("notes.md")],
            duration: nil,
            isError: nil,
            stableID: "call-read-notes"
        )))
        originalStreamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool.completed",
            name: "read_file",
            preview: "Read jungle notes",
            args: ["path": .string("notes.md")],
            duration: 0.15,
            isError: false,
            stableID: "call-read-notes"
        )))
        originalStreamClient.emit(.token("Once Raj reached the river. "))

        originalViewModel.suspendStreamForNavigation()

        XCTAssertEqual(originalStreamClient.stopCount, 1)

        let reopenedStreamClient = SpySSEStreamingClient()
        var didRequestStatus = false
        var sessionReloadCount = 0
        let reopenedViewModel = try makeViewModel(streamClient: reopenedStreamClient) { request in
            switch request.url?.path {
            case "/api/session":
                sessionReloadCount += 1
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Tiger Story",
                    "active_stream_id": "stream-123",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Tell me a tiger story",
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

        await reopenedViewModel.loadMessages()
        await reopenedViewModel.reconnectStreamIfNeeded()

        XCTAssertTrue(didRequestStatus)
        XCTAssertEqual(sessionReloadCount, 2)
        XCTAssertEqual(reopenedStreamClient.startedURLs.count, 1)
        XCTAssertEqual(reopenedViewModel.activeStreamID, "stream-123")
        XCTAssertEqual(reopenedViewModel.liveReasoningText, "Planning the tiger story.")
        XCTAssertEqual(reopenedViewModel.liveToolCalls.count, 1)
        XCTAssertEqual(reopenedViewModel.liveToolCalls.first?.name, "read_file")
        XCTAssertEqual(reopenedViewModel.liveToolCalls.first?.isCompleted, true)
        XCTAssertEqual(reopenedViewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(reopenedViewModel.messages.last?.content, "Once Raj reached the river. ")

        reopenedStreamClient.emit(.token("The snare broke."))

        XCTAssertEqual(
            reopenedViewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Once Raj reached the river. The snare broke."]
        )
        XCTAssertEqual(reopenedViewModel.messages.filter { $0.role == "assistant" }.count, 1)
    }

    // TAL-250: reopening a running session paints the run's live snapshot from the selected row's server stream id
    // before the session load answers, so its prose, reasoning and tools never drop out while the load is delayed.
    func testReopeningRunningSessionPaintsLiveSnapshotBeforeSessionLoadAnswers() async throws {
        let streamID = "stream-tal250-reopen"
        try await suspendRunWithLiveSnapshot(streamID: streamID)
        let context = try makeContext()
        let sessionRequested = expectation(description: "session requested")
        let releaseSession = DispatchSemaphore(value: 0)
        let reopenedViewModel = try makeViewModel(sessionSummary: try makeRunningRow(streamID: streamID)) { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            sessionRequested.fulfill()
            XCTAssertEqual(releaseSession.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse("""
            {"session": {"session_id": "session-abc", "title": "Tiger Story", "active_stream_id": "\(streamID)",
              "messages": [{"role": "user", "content": "Tell me a tiger story", "timestamp": 1770000100, "message_id": "user-1"}]}}
            """, for: request)
        }
        defer { releaseSession.signal() }

        reopenedViewModel.prepareInitialMessageLoad(modelContext: context)

        // The row's hint paints; only the session load may adopt the run. The "Syncing messages" pill (TAL-436)
        // covers the unconfirmed run state, so the transcript's own check chip stays hidden.
        XCTAssertNil(reopenedViewModel.activeStreamID)
        XCTAssertTrue(reopenedViewModel.isSyncingTranscript)
        XCTAssertFalse(reopenedViewModel.showsRunStateCheck)
        assertLiveTigerRun(reopenedViewModel)

        let load = Task { @MainActor in await reopenedViewModel.loadMessages(modelContext: context) }
        await fulfillment(of: [sessionRequested], timeout: 10)
        assertLiveTigerRun(reopenedViewModel)
        XCTAssertTrue(reopenedViewModel.isSyncingTranscript)
        XCTAssertFalse(reopenedViewModel.showsRunStateCheck)

        releaseSession.signal()
        await load.value

        // The server confirms the same run: it is adopted and its live work stays.
        XCTAssertEqual(reopenedViewModel.activeStreamID, streamID)
        XCTAssertFalse(reopenedViewModel.showsRunStateCheck)
        assertLiveTigerRun(reopenedViewModel)
    }

    // TAL-250: a run that finished before the session load answered settles once to the server's transcript.
    func testReopenedRunThatFinishedBeforeSessionLoadSettlesToTheServerTranscript() async throws {
        let streamID = "stream-tal250-finished"
        try await suspendRunWithLiveSnapshot(streamID: streamID)
        let context = try makeContext()
        let reopenedViewModel = try makeViewModel(sessionSummary: try makeRunningRow(streamID: streamID)) { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {"session": {"session_id": "session-abc", "title": "Tiger Story", "active_stream_id": null, "transcript_seq": null,
              "messages": [
                {"role": "user", "content": "Tell me a tiger story", "timestamp": 1770000100, "message_id": "user-1"},
                {"role": "assistant", "content": "Raj crossed the river.", "timestamp": 1770000200, "message_id": "assistant-1"}
              ]}}
            """, for: request)
        }

        reopenedViewModel.prepareInitialMessageLoad(modelContext: context)
        assertLiveTigerRun(reopenedViewModel)
        await reopenedViewModel.loadMessages(modelContext: context)

        XCTAssertNil(reopenedViewModel.activeStreamID)
        XCTAssertFalse(reopenedViewModel.showsRunStateCheck)
        XCTAssertTrue(reopenedViewModel.liveActivityRows.isEmpty)
        XCTAssertEqual(
            reopenedViewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Raj crossed the river."]
        )
    }

    /// Starts `streamID`, streams reasoning, a tool and prose, then leaves the chat so the run's live snapshot is saved.
    private func suspendRunWithLiveSnapshot(streamID: String) async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"\#(streamID)"}"#, for: request)
        }
        let didStart = await viewModel.sendMessage("Tell me a tiger story")
        XCTAssertTrue(didStart)
        streamClient.emit(.reasoning("Planning the tiger story."))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started", name: "read_file", preview: "Reading jungle notes",
            args: ["path": .string("notes.md")], duration: nil, isError: nil
        )))
        streamClient.emit(.token("Once Raj reached the river. "))
        viewModel.suspendStreamForNavigation()
    }

    private func makeRunningRow(streamID: String) throws -> SessionSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SessionSummary.self, from: Data("""
        {"session_id":"session-abc","title":"Tiger Story","is_streaming":true,"active_stream_id":"\(streamID)"}
        """.utf8))
    }

    private func assertLiveTigerRun(_ viewModel: ChatViewModel, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(viewModel.liveReasoningText, "Planning the tiger story.", file: file, line: line)
        XCTAssertEqual(viewModel.liveToolCalls.map(\.name), ["read_file"], file: file, line: line)
        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Once Raj reached the river. "],
            file: file,
            line: line
        )
    }
}

extension ChatViewModelSendTests {
    /// A relaunched process adopting a run: no snapshot and no cursor. The session
    /// detail (`transcriptJSON`) states the run's transcript cursor or null.
    @MainActor
    private func makeColdRelaunchViewModel(
        streamClient: SpySSEStreamingClient,
        transcriptJSON: String
    ) throws -> ChatViewModel {
        try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Tiger Story",
                    "active_stream_id": "stream-123",
                    \(transcriptJSON)
                  }
                }
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
    }

    @MainActor
    private func liveProse(_ viewModel: ChatViewModel) -> [String] {
        viewModel.liveActivityRows.compactMap { row in
            guard case .prose(let text) = row.content else { return nil }
            return text
        }
    }

    // TAL-316: the server leaves the running turn's output to the journal replay and
    // says so with `transcript_seq`; the client resumes there and renders the replay
    // as-is, with no text matching against the transcript.
    @MainActor
    func testColdRelaunchResumesFromTranscriptCursorAndRendersEachSegmentOnce() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, transcriptJSON: """
        "transcript_seq": { "stream_id": "stream-123", "seq": 0 },
        "messages": [
          { "role": "user", "content": "Earlier question", "timestamp": 1770000000, "message_id": "user-0" },
          { "role": "assistant", "content": "Earlier answer.", "timestamp": 1770000001, "message_id": "assistant-0" },
          { "role": "user", "content": "Tell me a tiger story", "timestamp": 1770000100, "message_id": "user-1" }
        ]
        """)
        let startedTool = ToolStreamEvent(
            eventType: "tool.started", name: "read_file", preview: "Reading jungle notes",
            args: ["path": .string("notes.md")], duration: nil, isError: nil, stableID: "call-1"
        )
        let completedTool = ToolStreamEvent(
            eventType: "tool.completed", name: "read_file", preview: "Read jungle notes",
            args: ["path": .string("notes.md")], duration: 0.15, isError: false, stableID: "call-1"
        )

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        XCTAssertNil(viewModel.streamingAssistantMessageID)

        streamClient.emit(.token("Reading jungle notes."), lastEventID: "stream-123:1")
        streamClient.emit(.toolStarted(startedTool), lastEventID: "stream-123:2")
        streamClient.emit(.toolCompleted(completedTool), lastEventID: "stream-123:3")
        streamClient.emit(.token("Once Raj reached the river."), lastEventID: "stream-123:4")

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "tools", "prose"])
        XCTAssertEqual(liveProse(viewModel), ["Reading jungle notes.", "Once Raj reached the river."])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.id), ["call-1"])
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 2)
        XCTAssertEqual(viewModel.messages.first { $0.messageId == "assistant-0" }?.content, "Earlier answer.")

        // A later reconnect resumes after this process's own cursor; the server's
        // overlap at that cursor is never applied again.
        viewModel.suspendStreamForNavigation()
        await viewModel.reconnectStreamIfNeeded()

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let resumedQuery = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(resumedQuery.first(where: { $0.name == "after_seq" })?.value, "4")
        streamClient.emit(.token("Once Raj reached the river."), lastEventID: "stream-123:4")
        streamClient.emit(.token(" The snare broke."), lastEventID: "stream-123:5")

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "tools", "prose"])
        XCTAssertEqual(liveProse(viewModel), ["Reading jungle notes.", "Once Raj reached the river. The snare broke."])
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 2)
    }

    // Old-server fallback: a Web without `transcript_seq` still sends the running
    // turn's persisted rows, so the app drops them after the prompt and replays from 0.
    @MainActor
    func testColdRelaunchAgainstServerWithoutCursorFieldRendersEachSegmentOnce() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, transcriptJSON: """
        "pending_started_at": 1770000100,
        "messages": [
          { "role": "user", "content": "Earlier question", "timestamp": 1770000000, "message_id": "user-0" },
          { "role": "assistant", "content": "Earlier answer.", "timestamp": 1770000001, "message_id": "assistant-0" },
          { "role": "user", "content": "Tell me a tiger story", "timestamp": 1770000100, "message_id": "user-1" },
          { "role": "assistant", "content": "Once Raj reached the river. ", "timestamp": 1770000101, "message_id": "assistant-1" },
          { "role": "user", "content": "Make it scary", "timestamp": 1770000102, "message_id": "steer-row-1", "_steer": { "steer_id": "steer-a" } }
        ]
        """)

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        // The replay supplies the turn's output; the user's steers stay.
        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Earlier question", "Earlier answer.", "Tell me a tiger story", "Make it scary"]
        )

        streamClient.emit(.token("Once Raj reached the river. "), lastEventID: "stream-123:1")
        streamClient.emit(.token("The snare broke."), lastEventID: "stream-123:2")

        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. The snare broke."])
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.compactMap(\.content), [
            "Earlier answer.", "Once Raj reached the river. The snare broke."
        ])
        XCTAssertEqual(viewModel.messages.filter { $0.steer != nil }.map(\.content), ["Make it scary"])
    }

    @MainActor
    func testOldServerFallbackKeepsTheUsersPendingSteeringHint() async throws {
        let streamClient = SpySSEStreamingClient()
        let now = serverNow
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/chat/steer":
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-123"}"#, for: request)
            case "/api/session":
                // A Web that predates `transcript_seq`: the running turn's persisted rows, no cursor key.
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "active_stream_id": "stream-123",
                    "pending_started_at": \(now),
                    "messages": [
                      { "role": "user", "content": "Initial request", "timestamp": \(now), "message_id": "user-1" },
                      { "role": "assistant", "content": "Before hint. ", "timestamp": \(now + 1), "message_id": "assistant-1" }
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(#"{"active":true,"stream_id":"stream-123","replay_available":true}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Before hint. "))
        _ = await viewModel.executeSlashCommand(
            try XCTUnwrap(SlashCommandCatalog.command(named: "steer")),
            args: "Use the focused test"
        )
        viewModel.suspendStreamForNavigation()
        await viewModel.reconnectStreamIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        // The loaded output is gone and the user's hint survives the trim. (A reload
        // merge can repeat the hint on every server; that predates TAL-316.)
        XCTAssertTrue(viewModel.messages.filter { $0.role == "assistant" }.isEmpty)
        XCTAssertEqual(Set(viewModel.messages.filter(\.isLocalSteeringHint).compactMap(\.content)), ["Use the focused test"])

        streamClient.emit(.token("Before hint. "), lastEventID: "stream-123:1")
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.compactMap(\.content), ["Before hint. "])
    }

    // Early in a run the old server may not hold the running prompt yet: the latest
    // loaded prompt belongs to the previous turn, whose settled answer must stay.
    @MainActor
    func testOldServerFallbackKeepsThePreviousTurnWhenTheRunningPromptIsNotLoaded() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, transcriptJSON: """
        "pending_started_at": 1770000200,
        "messages": [
          { "role": "user", "content": "Earlier question", "timestamp": 1770000000, "message_id": "user-0" },
          { "role": "assistant", "content": "Earlier answer.", "timestamp": 1770000001, "message_id": "assistant-0" }
        ]
        """)

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        let url = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" }))
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Earlier question", "Earlier answer."])
    }

    @MainActor
    func testColdRelaunchWithoutJournalRendersPersistedSegmentsAndRequestsNoReplay() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, transcriptJSON: """
        "transcript_seq": null,
        "messages": [
          { "role": "user", "content": "Tell me a tiger story", "timestamp": 1770000100, "message_id": "user-1" },
          { "role": "assistant", "content": "Once Raj reached the river. ", "timestamp": 1770000101, "message_id": "assistant-1" }
        ]
        """)

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        let url = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "replay" }))
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" }))
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Tell me a tiger story", "Once Raj reached the river. "])

        streamClient.emit(.token("The snare broke."))

        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Once Raj reached the river. The snare broke."]
        )
    }

    @MainActor
    func testSameStreamReloadWithoutPersistenceContextKeepsUncachedOptimisticPrompt() async throws {
        let streamClient = SpySSEStreamingClient()
        var reloadedActiveStreamID = "stream-123"
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "active_stream_id": "\(reloadedActiveStreamID)",
                    "messages": []
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
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working"])

        // No ModelContext, so the optimistic prompt was never cached, and the server
        // has not persisted it yet — but the same run is still authoritative.
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working"])
        XCTAssertEqual(viewModel.messages.filter { $0.role == "user" }.count, 1)

        // A different run owns the transcript now, so its rows win.
        reloadedActiveStreamID = "stream-999"
        await viewModel.loadMessages()
        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    @MainActor
    func testRecoveryWarningClearsOnStreamActivityButLeavesSendErrorAlone() async throws {
        let streamClient = SpySSEStreamingClient()
        var failsStatus = true
        var failsStart = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                if failsStart {
                    throw URLError(.notConnectedToInternet)
                }
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                if failsStatus {
                    // Same error the failing send below raises, so only ownership
                    // — never matching text — can tell the two warnings apart.
                    throw URLError(.notConnectedToInternet)
                }
                return apiTestJSONResponse("""
                {
                  "active": true,
                  "stream_id": "stream-123"
                }
                """, for: request)
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
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        viewModel.suspendStreamForBackground()
        await viewModel.reconnectStreamIfNeeded()
        XCTAssertNotNil(viewModel.sendErrorMessage)

        failsStatus = false
        await viewModel.reconnectStreamIfNeeded()
        streamClient.emit(.heartbeat)

        // A healthy transport proved recovery, so its transient warning is retracted.
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertNil(viewModel.lastError)

        // A recovery warning that a later send failure replaced is no longer
        // recovery-owned, so the next burst of stream activity must leave it alone.
        failsStatus = true
        viewModel.suspendStreamForBackground()
        await viewModel.reconnectStreamIfNeeded()
        XCTAssertNotNil(viewModel.sendErrorMessage)

        failsStart = true
        let didStartSecondSend = await viewModel.sendMessage("Another prompt")
        XCTAssertFalse(didStartSecondSend)
        let sendError = try XCTUnwrap(viewModel.sendErrorMessage)

        failsStatus = false
        await viewModel.reconnectStreamIfNeeded()
        streamClient.emit(.token(" More."))

        XCTAssertEqual(viewModel.sendErrorMessage, sendError)
    }

    /// A transport loss mid-stream reattaches and the answer continues without repeating what
    /// was already shown, then settles and ends the stream (formerly
    /// `ChatRecoveryUITests.testChatStreamReconnectsAfterTransportLoss`, TAL-402).
    @MainActor
    func testTransportLossReattachesAndContinuesTheAnswerOnceThenSettles() async throws {
        let streamClient = SpySSEStreamingClient()
        var settled = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(#"{"active":true,"stream_id":"stream-123"}"#, for: request)
            case "/api/session":
                let assistant = settled
                    ? #",{"role":"assistant","content":"Before reconnect. After reconnect.","timestamp":1770000101,"message_id":"assistant-1"}"#
                    : ""
                return apiTestJSONResponse("""
                {"session":{"session_id":"session-abc","title":"Planning",\
                "active_stream_id":\(settled ? "null" : #""stream-123""#),"messages":[\
                {"role":"user","content":"Run the deterministic fixture","timestamp":1770000100,"message_id":"user-1"}\
                \(assistant)]}}
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        _ = await viewModel.sendMessage("Run the deterministic fixture")
        streamClient.emit(.token("Before reconnect."))
        streamClient.emit(.transportError("The network connection was lost."))
        try await waitUntil { streamClient.startedURLs.count == 2 }
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")

        streamClient.emit(.token(" After reconnect."))
        try await waitUntil {
            viewModel.messages.last?.content == "Before reconnect. After reconnect."
        }
        settled = true
        streamClient.emit(.done(DoneStreamEvent()))
        streamClient.emit(.streamEnd)
        try await waitUntil { viewModel.activeStreamID == nil }

        let assistants = viewModel.messages.filter { $0.role == "assistant" }
        XCTAssertEqual(assistants.map(\.content), ["Before reconnect. After reconnect."])
        XCTAssertNil(viewModel.sendErrorMessage)
    }
}
