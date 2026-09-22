import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria

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
                      },
                      {
                        "role": "assistant",
                        "content": "First middle ",
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
    func testStaleActiveStreamReconnectsWithReplayFromBeginningWhenLastEventIDIsMissing() async throws {
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

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(uniqueKeysWithValues: queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["replay"], "1")
        XCTAssertEqual(query["after_seq"], "0")

        streamClient.emit(.token("First "))
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First "])

        streamClient.emit(.token("answer."))

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
    func testStaleActiveStreamReplayDeduplicatesMultiTokenPrefix() async throws {
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
        streamClient.emit(.token("middle "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        streamClient.emit(.token("First "))
        streamClient.emit(.token("middle "))
        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First middle "])

        streamClient.emit(.token("last."))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First middle last."])
    }

    @MainActor
    func testStaleActiveStreamReplayReasoningDoesNotDisarmTokenDeduplication() async throws {
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
        streamClient.emit(.token("middle "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        // The journal replays a reasoning segment this transcript never showed, so
        // that channel is genuinely new. Replay dedup is armed per channel, so the
        // replayed tokens behind it must still be recognised as already rendered.
        streamClient.emit(.reasoning(ReasoningStreamEvent(text: "Thinking it through.", titles: [])))
        streamClient.emit(.token("First "))
        streamClient.emit(.token("middle "))
        streamClient.emit(.token("last."))

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First middle last."])
    }

    @MainActor
    func testStaleActiveStreamReplayBatchedTokensMatchLiveModeFinalContent() async throws {
        let tokens = ["Alpha ", "beta ", "gamma ", "delta."]

        let liveStreamClient = SpySSEStreamingClient()
        let liveViewModel = try makeViewModel(streamClient: liveStreamClient) { request in
            switch request.url?.path {
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

        let didStartLive = await liveViewModel.sendMessage("Keep working")
        XCTAssertTrue(didStartLive)
        for token in tokens {
            liveStreamClient.emit(.token(token))
        }
        let liveTranscript = liveViewModel.messages.compactMap(\.content)
        XCTAssertEqual(liveTranscript, ["Keep working", "Alpha beta gamma delta."])

        let replayStreamClient = SpySSEStreamingClient()
        let replayViewModel = try makeViewModel(streamClient: replayStreamClient) { request in
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

        let didStartReplay = await replayViewModel.sendMessage("Keep working")
        XCTAssertTrue(didStartReplay)
        replayStreamClient.emit(.token(tokens[0]))
        replayStreamClient.emit(.token(tokens[1]))

        await replayViewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        // The replay connection re-sends the full token sequence from the start.
        for token in tokens {
            replayStreamClient.emit(.token(token))
        }

        XCTAssertEqual(replayViewModel.messages.compactMap(\.content), liveTranscript)
    }

    @MainActor
    func testStaleActiveStreamReplayDedupSurvivesLoadOlderMessages() async throws {
        let streamClient = SpySSEStreamingClient()
        // Hold received text in the pending buffers so pagination is what flushes it.
        streamClient.automaticallyFlushPendingStreamingContent = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            streamingScrollCoalescingDelayNanoseconds: 60_000_000_000
        ) { request in
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
                          {"role": "user", "content": "Old question", "timestamp": 1, "message_id": "u-0"},
                          {"role": "assistant", "content": "Old answer", "timestamp": 2, "message_id": "a-1"},
                          {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"}
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
                      {"role": "user", "content": "Recent question", "timestamp": 3, "message_id": "u-2"}
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

        await viewModel.loadMessages()
        XCTAssertTrue(viewModel.hasOlderMessages)

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("First "))
        streamClient.emit(.token("middle "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))

        // Partial replay match keeps the replay connection armed mid-stride...
        streamClient.emit(.token("First "))

        // ...then the user paginates older messages, which flushes pending buffers.
        let didLoadOlder = await viewModel.loadOlderMessages()
        XCTAssertTrue(didLoadOlder)
        XCTAssertEqual(viewModel.messages.last?.content, "First middle ")

        // Replay continues: the duplicate must still dedup, the new token must append.
        streamClient.emit(.token("middle "))
        streamClient.emit(.token("last."))
        viewModel.flushPendingStreamingContent()

        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Old question",
            "Old answer",
            "Recent question",
            "Keep working",
            "First middle last."
        ])
    }

    @MainActor
    func testStaleActiveStreamReplayDeduplicatesStridingOverlap() async throws {
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
        streamClient.emit(.token("First middle "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.token("middle last."))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First middle last."])
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
        streamClient.emit(.token("First "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.token("First "))

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
    func testStaleActiveStreamReplayDedupFallbackDoesNotSuppressNextNewToken() async throws {
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
        streamClient.emit(.token("First middle "))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.token("middle "))
        streamClient.emit(.token("First "))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .idle)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "First middle First "])
    }

    @MainActor
    func testStaleActiveStreamReplayDeduplicatesInterimAssistant() async throws {
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
        streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(text: "Draft answer.")))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(text: "Draft answer.")))

        XCTAssertEqual(viewModel.activeStreamRecoveryState, .reconnecting)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working", "Draft answer."])
    }

    @MainActor
    func testStaleActiveStreamReplayDeduplicatesMixedTokenToolAndReasoningEvents() async throws {
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
            isError: nil
        )
        let completedTool = ToolStreamEvent(
            eventType: "tool.completed",
            name: "run_command",
            preview: "Passed tests",
            args: ["cmd": .string("xcodebuild test")],
            duration: 1.5,
            isError: false
        )

        let didStart = await viewModel.sendMessage("Inspect logs")
        XCTAssertTrue(didStart)
        let titleEvent = TitleStreamEvent(sessionId: "session-abc", title: "Inspect logs")
        streamClient.emit(.title(titleEvent))
        streamClient.emit(.token("Checking. "))
        streamClient.emit(.toolStarted(startedTool))
        streamClient.emit(.toolCompleted(completedTool))
        streamClient.emit(.reasoning("Plan."))

        await viewModel.recoverStaleActiveStreamIfNeeded(now: Date().addingTimeInterval(20))
        streamClient.emit(.title(titleEvent))
        streamClient.emit(.token("Checking. "))
        streamClient.emit(.toolStarted(startedTool))
        streamClient.emit(.toolCompleted(completedTool))
        streamClient.emit(.reasoning("Plan."))

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Inspect logs", "Checking. "])
        XCTAssertEqual(viewModel.liveReasoningText, "Plan.")
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(viewModel.liveToolCalls.first?.name, "run_command")
        XCTAssertEqual(viewModel.liveToolCalls.first?.preview, "Passed tests")
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)

        streamClient.emit(.token("Checking. "))
        streamClient.emit(.toolStarted(startedTool))
        streamClient.emit(.toolCompleted(completedTool))

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
            isError: nil
        )))
        originalStreamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool.completed",
            name: "read_file",
            preview: "Read jungle notes",
            args: ["path": .string("notes.md")],
            duration: 0.15,
            isError: false
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
}

extension ChatViewModelSendTests {
    /// A relaunched process adopting a run: no snapshot, no cursor, and a
    /// transcript whose latest turn (`turnMessagesJSON`, one or more messages)
    /// already holds the streamed answer prefix.
    @MainActor
    private func makeColdRelaunchViewModel(
        streamClient: SpySSEStreamingClient,
        turnMessagesJSON: String
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
                    "messages": [
                      {
                        "role": "user",
                        "content": "Tell me a tiger story",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      \(turnMessagesJSON)
                    ]
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
    func testColdReplayLoadsMissingTurnPrefixWithoutExpandingVisibleWindow() async throws {
        try await assertPagedColdReplay()
    }

    @MainActor
    func testColdReplayInfersLegacyHistoryOffsetsFromRequestedCursor() async throws {
        try await assertPagedColdReplay(omitOffsets: true)
    }

    @MainActor
    func testColdReplayWaitsWhenMissingPrefixRequestFails() async throws {
        try await assertPagedColdReplay(failHistory: true)
    }

    @MainActor
    func testColdReplayRejectsHistoryPageThatDoesNotAdvance() async throws {
        try await assertPagedColdReplay(stallHistory: true)
    }

    @MainActor
    private func assertPagedColdReplay(
        failHistory: Bool = false,
        stallHistory: Bool = false,
        omitOffsets: Bool = false
    ) async throws {
        let streamClient = SpySSEStreamingClient()
        var allMessages: [[String: Any]] = [
            ["role": "user", "content": "Previous prompt", "message_id": "previous-user"],
            ["role": "assistant", "content": "Previous answer", "message_id": "previous-assistant"],
            ["role": "user", "content": "Long active turn", "message_id": "current-user"]
        ]
        allMessages += (1...101).map { index in
            ["role": "assistant", "content": "Part \(index).", "message_id": "part-\(index)"]
        }
        var historyRequests: [Int] = []
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/session":
                let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
                XCTAssertEqual(query.first { $0.name == "msg_limit" }?.value, "50")
                let before = query.first { $0.name == "msg_before" }?.value.flatMap(Int.init)
                if let before {
                    historyRequests.append(before)
                    if failHistory { throw URLError(.timedOut) }
                }
                let end = before ?? allMessages.count
                let offset = max(0, end - 50)
                var session: [String: Any] = [
                    "session_id": "session-abc", "active_stream_id": "stream-123",
                    "messages": Array(allMessages[offset..<end]),
                    "message_count": allMessages.count,
                    "_messages_truncated": offset > 0
                ]
                if !omitOffsets {
                    session["_messages_offset"] = stallHistory && before != nil ? end : offset
                }
                let data = try JSONSerialization.data(withJSONObject: ["session": session])
                return apiTestJSONResponse(try XCTUnwrap(String(data: data, encoding: .utf8)), for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(
                    #"{"active":true,"stream_id":"stream-123","replay_available":true}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages()
        let visible = viewModel.messages.compactMap(\.content)
        XCTAssertEqual(viewModel.messagesOffset, 54)
        await viewModel.reconnectStreamIfNeeded()

        if failHistory || stallHistory {
            XCTAssertEqual(historyRequests, [54])
            XCTAssertTrue(streamClient.startedURLs.isEmpty)
            XCTAssertTrue(viewModel.isActiveStreamConnectionSuspended)
            XCTAssertNotNil(viewModel.lastError)
            XCTAssertEqual(viewModel.messages.compactMap(\.content), visible)
            return
        }

        XCTAssertEqual(historyRequests, [54, 4])
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        for index in 1...101 {
            streamClient.emit(.token("Part "))
            streamClient.emit(.token("\(index)."))
        }
        XCTAssertEqual(viewModel.messagesOffset, 54)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), visible)
        XCTAssertEqual(liveProse(viewModel).joined(), visible.joined())

        streamClient.emit(.token("New suffix."))
        XCTAssertEqual(viewModel.messages.last?.content, "Part 101.New suffix.")
        XCTAssertEqual(liveProse(viewModel).joined(), visible.joined() + "New suffix.")
    }

    @MainActor
    private func liveProse(_ viewModel: ChatViewModel) -> [String] {
        viewModel.liveActivityRows.compactMap { row in
            guard case .prose(let text) = row.content else { return nil }
            return text
        }
    }

    // TAL-148: the cold replay from sequence zero lands on the live timeline that
    // `loadMessages` just emptied, and live rows win over the persisted scene, so a
    // journal opening with reasoning used to hide the loaded answer until `.done`.
    @MainActor
    func testColdRelaunchReplayKeepsLoadedPrefixVisibleWhenJournalOpensWithReasoning() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, turnMessagesJSON: """
        {
          "role": "assistant",
          "content": "Once Raj reached the river. ",
          "reasoning": "Planning the tiger story.",
          "timestamp": 1770000101,
          "message_id": "assistant-1"
        }
        """)

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["reasoning", "prose"])
        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. "])
        XCTAssertFalse(viewModel.liveActivityRows.contains(where: \.isFinalAnswer))

        streamClient.emit(.reasoning("Planning the tiger story."))

        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. "])
        XCTAssertEqual(viewModel.liveReasoningText, "Planning the tiger story.")

        streamClient.emit(.token("Once Raj "))
        streamClient.emit(.token("reached the river. "))

        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. "])
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Tell me a tiger story", "Once Raj reached the river. "])

        streamClient.emit(.token("The snare broke."))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["reasoning", "prose"])
        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. The snare broke."])
        XCTAssertEqual(viewModel.liveReasoningText, "Planning the tiger story.")
        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Once Raj reached the river. The snare broke."]
        )
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 1)
    }

    @MainActor
    func testColdRelaunchReplayKeepsLoadedPrefixVisibleWhenJournalOpensWithTool() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, turnMessagesJSON: """
        {
          "role": "assistant",
          "content": "Once Raj reached the river. ",
          "timestamp": 1770000101,
          "message_id": "assistant-1"
        }
        """)
        let startedTool = ToolStreamEvent(
            eventType: "tool.started",
            name: "read_file",
            preview: "Reading jungle notes",
            args: ["path": .string("notes.md")],
            duration: nil,
            isError: nil
        )
        let completedTool = ToolStreamEvent(
            eventType: "tool.completed",
            name: "read_file",
            preview: "Read jungle notes",
            args: ["path": .string("notes.md")],
            duration: 0.15,
            isError: false
        )

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. "])

        streamClient.emit(.toolStarted(startedTool))
        streamClient.emit(.toolCompleted(completedTool))

        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. "])
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)

        streamClient.emit(.token("Once Raj reached the river. "))

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Tell me a tiger story", "Once Raj reached the river. "])

        streamClient.emit(.token("The snare broke."))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "tools", "prose"])
        XCTAssertEqual(liveProse(viewModel), ["Once Raj reached the river. ", "The snare broke."])
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Once Raj reached the river. The snare broke."]
        )
    }

    // A tool-driven turn spans several assistant messages that the transcript
    // renders as one block, so the seed must cover every segment, and the
    // replayed tool events must land on the seeded rows instead of after them.
    @MainActor
    func testColdRelaunchReplaySeedsEveryAssistantSegmentOfTheTurn() async throws {
        try await assertColdReplayDeduplicatesEveryAssistantSegment(useInterim: false)
    }

    @MainActor
    func testColdRelaunchReplayDeduplicatesInterimAcrossEveryAssistantSegment() async throws {
        try await assertColdReplayDeduplicatesEveryAssistantSegment(useInterim: true)
    }

    @MainActor
    func testColdRelaunchReplayDeduplicatesInterimThenTokens() async throws {
        try await assertColdReplayDeduplicatesEveryAssistantSegment(useInterim: true, switchChannelAfterTool: true)
    }

    @MainActor
    func testColdRelaunchReplayDeduplicatesTokensThenInterim() async throws {
        try await assertColdReplayDeduplicatesEveryAssistantSegment(useInterim: false, switchChannelAfterTool: true)
    }

    @MainActor
    private func assertColdReplayDeduplicatesEveryAssistantSegment(
        useInterim: Bool,
        switchChannelAfterTool: Bool = false
    ) async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeColdRelaunchViewModel(streamClient: streamClient, turnMessagesJSON: """
        {
          "role": "assistant",
          "content": "Reading jungle notes.",
          "timestamp": 1770000101,
          "message_id": "assistant-tool",
          "tool_calls": [
            {
              "id": "call-1",
              "function": {
                "name": "read_file",
                "arguments": "{\\"path\\":\\"notes.md\\"}"
              }
            }
          ]
        },
        {
          "role": "tool",
          "content": "Jungle notes",
          "timestamp": 1770000102,
          "message_id": "tool-1",
          "tool_call_id": "call-1"
        },
        {
          "role": "assistant",
          "content": "Once Raj reached the river. ",
          "timestamp": 1770000103,
          "message_id": "assistant-final"
        }
        """)
        let startedTool = ToolStreamEvent(
            eventType: "tool.started",
            name: "read_file",
            preview: "Reading jungle notes",
            args: ["path": .string("notes.md")],
            duration: nil,
            isError: nil,
            stableID: "call-1"
        )
        let completedTool = ToolStreamEvent(
            eventType: "tool.completed",
            name: "read_file",
            preview: "Read jungle notes",
            args: ["path": .string("notes.md")],
            duration: 0.15,
            isError: false,
            stableID: "call-1"
        )

        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        XCTAssertEqual(viewModel.streamingAssistantMessageID, "assistant-final")
        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["tools", "prose", "prose"])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.id), ["call-1"])
        XCTAssertEqual(liveProse(viewModel), ["Reading jungle notes.", "Once Raj reached the river. "])

        var replayUsesInterim = useInterim
        func replayProse(_ text: String) {
            if replayUsesInterim {
                streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(text: text)))
            } else {
                streamClient.emit(.token(text))
            }
        }
        if useInterim {
            replayProse("Reading jungle notes.")
        } else {
            replayProse("Reading ")
            replayProse("jungle notes.")
        }
        XCTAssertEqual(viewModel.messages.last?.content, "Once Raj reached the river. ")
        XCTAssertEqual(liveProse(viewModel), ["Reading jungle notes.", "Once Raj reached the river. "])

        streamClient.emit(.toolStarted(startedTool))
        streamClient.emit(.toolCompleted(completedTool))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["tools", "prose", "prose"])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.id), ["call-1"])
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)
        XCTAssertEqual(liveProse(viewModel), ["Reading jungle notes.", "Once Raj reached the river. "])

        if switchChannelAfterTool {
            replayUsesInterim.toggle()
        }
        if replayUsesInterim {
            replayProse("Once Raj reached the river. The snare broke.")
        } else {
            replayProse("Once Raj")
            replayProse(" reached the river. The snare broke.")
        }

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["tools", "prose", "prose"])
        XCTAssertEqual(liveProse(viewModel), ["Reading jungle notes.", "Once Raj reached the river. The snare broke."])
        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Tell me a tiger story", "Reading jungle notes.", "Jungle notes", "Once Raj reached the river. The snare broke."]
        )
        viewModel.streamCoordinatorDidStartConnection(isReplay: true)
        streamClient.emit(.token("Once Raj"))
        streamClient.emit(.token(" reached the river. The snare broke."))
        XCTAssertEqual(viewModel.messages.last?.content, "Once Raj reached the river. The snare broke.")
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
}
